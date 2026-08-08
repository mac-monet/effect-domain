import { Effect, Schema, SchemaAST } from "effect";
import { BatchFieldRequest, batchResolverFor } from "./define.ts";
import type { NodeRegistry } from "./registry.ts";
import { isNullable, isRecord, unwrapSuspend } from "./schema/ast.ts";
import { concreteUnionMember } from "./schema/sentinels.ts";
import { planRuntimeNode, planSelectedNode, type SelectedFieldPlan } from "./selection/plan.ts";
import { DuplicateOutputKey, type Selection, UndefinedSelectionEntry } from "./selection/syntax.ts";

export interface WalkContext {
  readonly concurrency: number | "unbounded";
  readonly registry: NodeRegistry;
  /** When present, the walker records every identified entity it touches. */
  readonly reads?: ReadSetCollector;
}

/**
 * One entity touched during a walk: the node's `node()` identifier and its
 * canonical entity key (from the node's `identity` declaration).
 *
 * @since 0.2.0
 * @category models
 */
export interface ReadSetEntry {
  readonly node: string;
  readonly key: string;
}

/**
 * The deduplicated set of identified entities a walk touched. The foundation
 * for sync-engine invalidation: subscriptions depending on any of these
 * entities must re-run when one changes.
 *
 * @since 0.2.0
 * @category models
 */
export type ReadSet = ReadonlyArray<ReadSetEntry>;

export interface ReadSetCollector {
  readonly entries: Array<ReadSetEntry>;
  readonly seen: Set<string>;
}

export function makeReadSetCollector(): ReadSetCollector {
  return { entries: [], seen: new Set() };
}

// Only registered nodes that declare both an identifier and an identity are
// recorded — the read set is a keyspace artifact, and entities without
// canonical keys cannot participate in invalidation.
function recordRead(ctx: WalkContext, ast: SchemaAST.AST, obj: Record<string, unknown>): void {
  const collector = ctx.reads;
  if (!collector) return;
  const registered = ctx.registry.lookup(ast);
  if (!registered?.identity || registered.identifier === undefined) return;
  const key = registered.identity.extract(obj);
  const dedupe = `${registered.identifier}\u0000${key}`;
  if (collector.seen.has(dedupe)) return;
  collector.seen.add(dedupe);
  collector.entries.push({ node: registered.identifier, key });
}

// Root contract violations are defects, not typed failures: every one is
// either a resolver bug (shape mismatch with the declared type) or unreachable
// through the typed API (RootSelectionFor<T> = never forbids `select` on
// opaque roots, and the gateway rejects such selections at decode time).
// Dying keeps `execute`'s error channel exactly the operation's declared
// failures: the resolver's E plus the E of every selected computed field —
// a field's typed failure fails the whole walk (strict semantics), while a
// field defect stays a defect and dies.
export function walkRoot<R>(
  value: unknown,
  ast: SchemaAST.AST,
  selection: Selection | undefined,
  ctx: WalkContext,
): Effect.Effect<unknown, unknown, R> {
  const plan = ctx.registry.rootPlanFor(ast);

  // Selection presence is checked before the null early-return so a nullable
  // node root cannot slip past the explicit-selection invariant.
  if (selection === undefined && plan._tag !== "OpaqueRoot") {
    return Effect.die(new Error("Walker: selection is required for node roots"));
  }

  if (value == null) {
    return plan.nullable
      ? Effect.succeed(null)
      : Effect.die(new Error("Resolver returned nullish value for non-nullable root"));
  }

  switch (plan._tag) {
    case "ObjectRoot":
      if (!isRecord(value)) return Effect.die(new Error("Resolver must return an object"));
      return walkNode<R>(value, plan.walkTarget, selection ?? {}, ctx);
    case "ArrayRoot": {
      if (!Array.isArray(value)) {
        return Effect.die(new Error("Resolver must return an array"));
      }
      const rootSelection = selection ?? {};
      return Effect.all(
        value.map((item) => resolveValue<R>(item, plan.element, rootSelection, ctx)),
        { concurrency: ctx.concurrency },
      );
    }
    case "OpaqueRoot":
      if (plan.mustBeArray && !Array.isArray(value)) {
        return Effect.die(new Error("Resolver must return an array"));
      }
      if (selection !== undefined) {
        return Effect.die(new Error("Opaque root does not accept a selection"));
      }
      return Effect.succeed(value);
  }
}

export function walkNode<R>(
  obj: Record<string, unknown>,
  ast: SchemaAST.AST,
  selection: Selection,
  ctx: WalkContext,
): Effect.Effect<Record<string, unknown>, unknown, R> {
  const typeAst = unwrapSuspend(ast);

  if (SchemaAST.isUnion(typeAst)) {
    const member = concreteUnionMember(obj, typeAst);
    if (!member) return Effect.die(new Error(unmatchedUnionMessage(obj)));
    return walkUnionMember<R>(obj, typeAst, member, selection, ctx);
  }

  recordRead(ctx, typeAst, obj);

  let plan: ReturnType<typeof planSelectedNode<R>>;
  try {
    plan = planSelectedNode<R>(ctx.registry, typeAst, selection);
  } catch (error) {
    return handleSelectionPlanError(error);
  }

  const effects: Array<Effect.Effect<readonly [string, unknown], unknown, R>> = [];

  for (const field of plan.fields) {
    effects.push(
      Effect.map(
        resolveEntry<R>(obj, field, ctx),
        (value) => [field.entry.outputKey, value] as const,
      ),
    );
  }

  return collectResolvedFields(effects, ctx);
}

function walkUnionMember<R>(
  obj: Record<string, unknown>,
  unionAst: SchemaAST.Union,
  memberAst: SchemaAST.AST,
  selection: Selection,
  ctx: WalkContext,
): Effect.Effect<Record<string, unknown>, unknown, R> {
  const concreteMemberAst = concreteObjectMemberAst(obj, memberAst);
  recordRead(ctx, concreteMemberAst, obj);
  let plan: ReturnType<typeof planRuntimeNode<R>>;
  try {
    plan = planRuntimeNode<R>(ctx.registry, unionAst, concreteMemberAst, selection);
  } catch (error) {
    return handleSelectionPlanError(error);
  }

  const effects: Array<Effect.Effect<readonly [string, unknown], unknown, R>> = [];

  for (const field of plan.fields) {
    if (field._tag === "MissingOnVariant") {
      effects.push(Effect.succeed([field.entry.outputKey, undefined] as const));
      continue;
    }

    effects.push(
      Effect.map(
        resolveEntry<R>(obj, field, ctx),
        (value) => [field.entry.outputKey, value] as const,
      ),
    );
  }

  return collectResolvedFields(effects, ctx);
}

function concreteObjectMemberAst(
  value: Record<string, unknown>,
  ast: SchemaAST.AST,
): SchemaAST.AST {
  const typeAst = unwrapSuspend(ast);
  if (!SchemaAST.isUnion(typeAst)) return typeAst;
  const member = concreteUnionMember(value, typeAst);
  return member ? concreteObjectMemberAst(value, member) : typeAst;
}

function collectResolvedFields<R>(
  effects: ReadonlyArray<Effect.Effect<readonly [string, unknown], unknown, R>>,
  ctx: WalkContext,
): Effect.Effect<Record<string, unknown>, unknown, R> {
  return Effect.map(Effect.all(effects, { concurrency: ctx.concurrency }), (resolved) => {
    const out: Record<string, unknown> = {};
    for (const [key, result] of resolved) {
      Object.defineProperty(out, key, {
        value: result,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  });
}

function handleSelectionPlanError<R>(error: unknown): Effect.Effect<never, never, R> {
  if (error instanceof DuplicateOutputKey) {
    return Effect.die(
      new Error(
        `Walker: duplicate output key "${error.outputKey}" in selection (use 'alias' to disambiguate multi-entry array selections)`,
      ),
    );
  }
  if (error instanceof UndefinedSelectionEntry) {
    return Effect.die(new Error(`Walker: undefined selection entry "${error.fieldName}"`));
  }
  return Effect.die(error);
}

// Selection args on a field that takes none is caller misuse the typed
// selection syntax cannot rule out, but the wire boundary already rejects it
// (strict per-field selection structs) — reaching this guard in-process means
// a bug at the call site, so it dies rather than failing the operation.
function resolveEntry<R>(
  obj: Record<string, unknown>,
  field: SelectedFieldPlan<R>,
  ctx: WalkContext,
): Effect.Effect<unknown, unknown, R> {
  const { entry } = field;
  const { args: rawArgs, fieldName, select: sub } = entry;

  if (field.fieldDef) {
    const fieldDef = field.fieldDef;
    if (rawArgs !== undefined && (fieldDef._kind === "batched" || !fieldDef.args)) {
      return Effect.die(new Error(`Field "${fieldName}" does not accept selection args`));
    }
    let resolveEffect: Effect.Effect<unknown, unknown, R>;
    if (fieldDef._kind === "batched") {
      const request = BatchFieldRequest({ key: fieldDef.key(obj) });
      // Resolver is selected per execution context so batches never merge
      // across concurrent runs with different provided services.
      resolveEffect = Effect.flatMap(Effect.context<never>(), (context) =>
        Effect.request(request, batchResolverFor(context, fieldDef.resolve)),
      ) as Effect.Effect<unknown, unknown, R>;
    } else {
      resolveEffect = fieldDef.args
        ? decodeAndResolve<R>(fieldDef.args, rawArgs, fieldDef.resolve, obj, field.childSelections)
        : fieldDef.resolve({ parent: obj, selections: field.childSelections });
    }
    if (!sub) return resolveEffect;
    const typeAst = fieldDef.type.ast;
    return Effect.flatMap(resolveEffect, (value) => resolveValue<R>(value, typeAst, sub, ctx));
  }

  const value = obj[fieldName];
  if (rawArgs !== undefined) {
    return Effect.die(new Error(`Field "${fieldName}" does not accept selection args`));
  }
  if (!sub) return Effect.succeed(value);
  const fieldAst = field.fieldAsts[0];
  return resolveValue<R>(value, fieldAst, sub, ctx);
}

function resolveValue<R>(
  value: unknown,
  ast: SchemaAST.AST | undefined,
  sub: Selection,
  ctx: WalkContext,
): Effect.Effect<unknown, unknown, R> {
  if (value == null) {
    // Absence is `null` — except an undefined value whose declared type is
    // not nullable (an absent optionalKey): that stays `undefined` so the
    // optional wire key can drop it, mirroring MissingOnVariant. A nullable
    // type's own undefined (UndefinedOr) still normalizes to `null`, which
    // its wire slot admits.
    const stayUndefined = value === undefined && ast !== undefined && !isNullable(ast);
    return Effect.succeed(stayUndefined ? undefined : null);
  }

  const typeAst = ast ? unwrapSuspend(ast) : undefined;

  if (typeAst && SchemaAST.isArrays(typeAst) && Array.isArray(value)) {
    const itemAst = typeAst.rest[0];
    return Effect.all(
      value.map((item) => resolveValue<R>(item, itemAst, sub, ctx)),
      { concurrency: ctx.concurrency },
    );
  }

  if (typeAst && SchemaAST.isObjects(typeAst) && isRecord(value)) {
    return walkNode<R>(value, typeAst, sub, ctx);
  }

  if (typeAst && SchemaAST.isUnion(typeAst)) {
    const member = concreteUnionMember(value, typeAst);
    if (!member) return Effect.die(new Error(unmatchedUnionMessage(value)));
    if (isRecord(value)) {
      return walkUnionMember<R>(value, typeAst, member, sub, ctx);
    }
    return resolveValue<R>(value, member, sub, ctx);
  }

  return Effect.succeed(value);
}

function unmatchedUnionMessage(value: unknown): string {
  if (isRecord(value)) {
    const tag = value["_tag"] ?? value["kind"] ?? value["type"];
    if (typeof tag === "string") {
      return `Walker: value matched no union variant (discriminator=${JSON.stringify(tag)})`;
    }
    return `Walker: value matched no union variant (keys=${JSON.stringify(Object.keys(value))})`;
  }
  return `Walker: value matched no union variant (typeof=${typeof value})`;
}

function decodeAndResolve<R>(
  argsSchema: Schema.Decoder<unknown>,
  rawArgs: unknown,
  resolve: (ctx: {
    readonly parent: unknown;
    readonly args?: unknown;
    readonly selections: ReadonlySet<string>;
  }) => Effect.Effect<unknown, unknown, R>,
  parent: unknown,
  selections: ReadonlySet<string>,
): Effect.Effect<unknown, unknown, R> {
  // Args decode failure is caller misuse, not a domain failure: selection
  // args are untyped in the selection syntax, the wire boundary has already
  // validated these exact raw args (SelectionParseError on mismatch), so an
  // in-process failure here means a bug at the call site — it dies rather
  // than leaking an undeclared SchemaError into the operation's error channel.
  return Effect.flatMap(Effect.orDie(Schema.decodeUnknownEffect(argsSchema)(rawArgs)), (args) =>
    resolve({ parent, args, selections }),
  );
}
