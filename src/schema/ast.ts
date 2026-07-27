import { Schema, SchemaAST } from "effect";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapSuspend(ast: SchemaAST.AST): SchemaAST.AST {
  let cur = ast;
  const seen = new Set<SchemaAST.AST>();
  while (SchemaAST.isSuspend(cur)) {
    if (seen.has(cur)) {
      throw new Error("SchemaAST: detected a Suspend cycle that never reaches a concrete type");
    }
    seen.add(cur);
    cur = cur.thunk();
  }
  return cur;
}

// Canonicalizing memo: toType rebuilds a fresh AST when applied to an
// already-unwrapped recursive Objects, so without a fixpoint entry
// (canonical → canonical) identity-keyed visited-sets never converge and
// traversals of recursive schemas recurse forever. Suspends are unwrapped on
// the raw side first, consulting the cache at each step, so a recursive
// schema's inner suspend resolves back to the canonical AST already produced
// for its root instead of triggering another toType rebuild.
const unwrapTypeCache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

export function unwrapType(ast: SchemaAST.AST): SchemaAST.AST {
  const cached = unwrapTypeCache.get(ast);
  if (cached) return cached;

  let raw = ast;
  const seen = new Set<SchemaAST.AST>();
  while (SchemaAST.isSuspend(raw)) {
    if (seen.has(raw)) {
      throw new Error("SchemaAST: detected a Suspend cycle that never reaches a concrete type");
    }
    seen.add(raw);
    raw = raw.thunk();
    const known = unwrapTypeCache.get(raw);
    if (known) {
      for (const step of seen) unwrapTypeCache.set(step, known);
      return known;
    }
  }

  // toType recurs through Suspend thunks, so unwrapSuspend sees type-side
  // thunk results here — and, unlike re-applying toType per unwrap (which
  // yields a fresh memoized Suspend each iteration), its cycle guard can
  // actually fire on self-referential suspends.
  const result = unwrapSuspend(SchemaAST.toType(raw));
  const canonical = unwrapTypeCache.get(result) ?? result;
  for (const step of seen) unwrapTypeCache.set(step, canonical);
  unwrapTypeCache.set(ast, canonical);
  unwrapTypeCache.set(raw, canonical);
  unwrapTypeCache.set(canonical, canonical);
  // toType is memoized per input but not idempotent: applied to its own
  // output it rebuilds a fresh AST generation. Rebuilt suspend wrappers
  // reachable from `canonical` resolve their thunks through exactly that
  // one-step rebuild, so registering the link toType(canonical) → canonical
  // makes recursive schemas converge instead of descending generations.
  unwrapTypeCache.set(SchemaAST.toType(canonical), canonical);
  return canonical;
}

export function isNullishAst(ast: SchemaAST.AST): boolean {
  const typeAst = unwrapType(ast);
  return SchemaAST.isNull(typeAst) || SchemaAST.isUndefined(typeAst) || SchemaAST.isVoid(typeAst);
}

export function isNullable(ast: SchemaAST.AST): boolean {
  const typeAst = unwrapType(ast);
  return isNullishAst(typeAst) || (SchemaAST.isUnion(typeAst) && typeAst.types.some(isNullishAst));
}

export function nonNullishMembers(union: SchemaAST.Union): ReadonlyArray<SchemaAST.AST> {
  return union.types.filter((member) => !isNullishAst(member)).map(unwrapType);
}

export function nonNullishRootAst(ast: SchemaAST.AST): SchemaAST.AST {
  const typeAst = unwrapType(ast);
  if (isNullishAst(typeAst)) return Schema.Never.ast;
  if (!SchemaAST.isUnion(typeAst)) return typeAst;
  const members = nonNullishMembers(typeAst);
  if (members.length === 0) return Schema.Never.ast;
  if (members.length === 1) return members[0]!;
  // Dynamic union synthesis: only the AST shape is needed downstream, so
  // member codec precision is intentionally erased.
  return Schema.Union(members.map((member) => Schema.make(member)) as never).ast;
}

export const MixedProjectableRoot = Symbol("effect-domain/MixedProjectableRoot");

export function projectableRootTarget(
  ast: SchemaAST.AST,
): SchemaAST.AST | undefined | typeof MixedProjectableRoot {
  const typeAst = unwrapType(ast);
  if (SchemaAST.isObjects(typeAst)) return typeAst;
  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    return inner ? projectableRootTarget(inner) : undefined;
  }
  if (SchemaAST.isUnion(typeAst)) {
    const targets: SchemaAST.AST[] = [];
    let opaque = 0;
    for (const member of typeAst.types) {
      const memberType = unwrapType(member);
      if (isNullishAst(memberType)) continue;
      const target = projectableRootTarget(memberType);
      if (target === MixedProjectableRoot) return MixedProjectableRoot;
      if (target) targets.push(target);
      else opaque++;
    }
    if (targets.length > 0 && opaque > 0) return MixedProjectableRoot;
    if (targets.length === 0) return undefined;
    const uniqueTargets = Array.from(new Set(targets));
    return uniqueTargets.length === 1
      ? uniqueTargets[0]!
      : // Dynamic union synthesis: we only need the AST target, so member codec
        // precision is intentionally erased while building the temporary Union.
        Schema.Union(uniqueTargets.map((target) => Schema.make(target)) as never).ast;
  }
  return undefined;
}

export function projectableRootDepths(ast: SchemaAST.AST): ReadonlySet<number> {
  const depths = new Set<number>();
  collectProjectableRootDepths(ast, 0, depths);
  return depths;
}

function collectProjectableRootDepths(
  ast: SchemaAST.AST,
  depth: number,
  depths: Set<number>,
): void {
  const typeAst = unwrapType(ast);
  if (isNullishAst(typeAst)) return;
  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    if (inner) collectProjectableRootDepths(inner, depth + 1, depths);
    return;
  }
  if (SchemaAST.isUnion(typeAst)) {
    for (const member of typeAst.types) {
      collectProjectableRootDepths(member, depth, depths);
    }
    return;
  }
  const target = projectableRootTarget(typeAst);
  if (target && target !== MixedProjectableRoot) {
    depths.add(depth);
  }
}

export function arrayWrappedProjectableUnionTarget(
  union: SchemaAST.Union,
): { readonly depth: number; readonly target: SchemaAST.AST } | undefined {
  const depths = projectableRootDepths(union);
  if (depths.size !== 1) return undefined;
  const depth = depths.values().next().value;
  if (depth === undefined || depth === 0) return undefined;
  const target = projectableRootTarget(union);
  if (!target || target === MixedProjectableRoot) return undefined;
  return { depth, target };
}

export function wrapAstInArrays(ast: SchemaAST.AST, depth: number): SchemaAST.AST {
  // Dynamic AST wrapping: each iteration changes the codec type, but this
  // helper only returns the resulting AST shape.
  let schema = Schema.make(ast) as Schema.Codec<unknown>;
  for (let i = 0; i < depth; i++) {
    schema = Schema.Array(schema) as unknown as Schema.Codec<unknown>;
  }
  return schema.ast;
}

/**
 * Resolves the nearest `identifier` annotation on an AST, looking through
 * annotation chains.
 *
 * @since 0.2.0
 * @category schema
 */
export function identifierOf(ast: SchemaAST.AST): string | undefined {
  return SchemaAST.resolveAt<string>("identifier")(ast);
}

/**
 * Splits a possibly-nullable AST into its non-nullish core and a nullability
 * flag, on the type side. `NullOr(User)` yields `{ core: User, nullable: true }`;
 * a union with more than one non-nullish member keeps the whole (unwrapped)
 * union as the core.
 *
 * @since 0.2.0
 * @category schema
 */
export function splitNullability(ast: SchemaAST.AST): {
  readonly core: SchemaAST.AST;
  readonly nullable: boolean;
} {
  const typeAst = unwrapType(ast);
  if (!SchemaAST.isUnion(typeAst)) {
    return { core: typeAst, nullable: isNullishAst(typeAst) };
  }
  const members = typeAst.types.filter((member) => !isNullishAst(member));
  const nullable = members.length < typeAst.types.length;
  if (members.length === 1) {
    return { core: unwrapType(members[0]!), nullable };
  }
  return { core: typeAst, nullable };
}
