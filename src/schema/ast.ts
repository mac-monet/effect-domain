import { Schema, SchemaAST } from "effect";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwraps Suspend nodes to reach the concrete AST. In Effect v4's
 * type-primary AST model, the raw AST already carries type-side structure
 * (`Schema.NumberFromString.ast._tag === "Number"`), so unwrapping suspends
 * is the only canonicalization needed — no `toType` roundtrip required.
 *
 * The returned AST has stable object identity: `Schema.suspend(() => User).ast.thunk()`
 * returns the same `User.ast` reference every call, so identity-keyed
 * visited-sets and WeakMap caches converge naturally on recursive schemas.
 *
 * Throws (never hangs) on pathological suspend chains: the cycle guard
 * detects self-referential suspends within the thunk chain, and a depth
 * bound catches thunks that mint a fresh Suspend node on every call (which
 * an identity-keyed guard alone can never detect).
 *
 * @since 0.1.0
 * @category schema
 */
const MAX_SUSPEND_DEPTH = 1000;

export function unwrapSuspend(ast: SchemaAST.AST): SchemaAST.AST {
  let cur = ast;
  const seen = new Set<SchemaAST.AST>();
  while (SchemaAST.isSuspend(cur)) {
    if (seen.size >= MAX_SUSPEND_DEPTH) {
      throw new Error(
        `SchemaAST: suspend chain exceeded ${MAX_SUSPEND_DEPTH} levels without reaching a concrete type — a suspend thunk is likely constructing a fresh schema on every call`,
      );
    }
    if (seen.has(cur)) {
      throw new Error("SchemaAST: detected a Suspend cycle that never reaches a concrete type");
    }
    seen.add(cur);
    cur = cur.thunk();
  }
  return cur;
}

export function isNullishAst(ast: SchemaAST.AST): boolean {
  const unwrapped = unwrapSuspend(ast);
  return (
    SchemaAST.isNull(unwrapped) || SchemaAST.isUndefined(unwrapped) || SchemaAST.isVoid(unwrapped)
  );
}

export function isNullable(ast: SchemaAST.AST): boolean {
  const unwrapped = unwrapSuspend(ast);
  return (
    isNullishAst(unwrapped) || (SchemaAST.isUnion(unwrapped) && unwrapped.types.some(isNullishAst))
  );
}

export function nonNullishMembers(union: SchemaAST.Union): ReadonlyArray<SchemaAST.AST> {
  return union.types.filter((member) => !isNullishAst(member)).map(unwrapSuspend);
}

// Undefined can reach a value slot three ways: the union-variant sentinel, a
// Void/Undefined-typed field, or a union with such a member
// (Schema.UndefinedOr). The response codec makes any such slot an optional
// key. `seen` guards recursive unions reachable through suspends; raw ASTs
// have stable identity so the guard converges naturally.
export function admitsUndefinedAst(ast: SchemaAST.AST, seen?: Set<SchemaAST.AST>): boolean {
  const unwrapped = unwrapSuspend(ast);
  if (SchemaAST.isUndefined(unwrapped) || SchemaAST.isVoid(unwrapped)) return true;
  if (!SchemaAST.isUnion(unwrapped)) return false;
  const visited = seen ?? new Set();
  if (visited.has(unwrapped)) return false;
  visited.add(unwrapped);
  return unwrapped.types.some((member) => admitsUndefinedAst(member, visited));
}

export function nonNullishRootAst(ast: SchemaAST.AST): SchemaAST.AST {
  const unwrapped = unwrapSuspend(ast);
  if (isNullishAst(unwrapped)) return Schema.Never.ast;
  if (!SchemaAST.isUnion(unwrapped)) return unwrapped;
  const members = nonNullishMembers(unwrapped);
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
  const unwrapped = unwrapSuspend(ast);
  if (SchemaAST.isObjects(unwrapped)) return unwrapped;
  if (SchemaAST.isArrays(unwrapped)) {
    const inner = unwrapped.rest[0];
    return inner ? projectableRootTarget(inner) : undefined;
  }
  if (SchemaAST.isUnion(unwrapped)) {
    const targets: SchemaAST.AST[] = [];
    let opaque = 0;
    for (const member of unwrapped.types) {
      const memberAst = unwrapSuspend(member);
      if (isNullishAst(memberAst)) continue;
      const target = projectableRootTarget(memberAst);
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
  const unwrapped = unwrapSuspend(ast);
  if (isNullishAst(unwrapped)) return;
  if (SchemaAST.isArrays(unwrapped)) {
    const inner = unwrapped.rest[0];
    if (inner) collectProjectableRootDepths(inner, depth + 1, depths);
    return;
  }
  if (SchemaAST.isUnion(unwrapped)) {
    for (const member of unwrapped.types) {
      collectProjectableRootDepths(member, depth, depths);
    }
    return;
  }
  const target = projectableRootTarget(unwrapped);
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
 * @since 0.1.0
 * @category schema
 */
export function identifierOf(ast: SchemaAST.AST): string | undefined {
  return SchemaAST.resolveAt<string>("identifier")(ast);
}

/**
 * Splits a possibly-nullable AST into its non-nullish core and a nullability
 * flag. `NullOr(User)` yields `{ core: User, nullable: true }`; a union with
 * more than one non-nullish member keeps the whole (unwrapped) union as the
 * core.
 *
 * @since 0.1.0
 * @category schema
 */
export function splitNullability(ast: SchemaAST.AST): {
  readonly core: SchemaAST.AST;
  readonly nullable: boolean;
} {
  const unwrapped = unwrapSuspend(ast);
  if (!SchemaAST.isUnion(unwrapped)) {
    return { core: unwrapped, nullable: isNullishAst(unwrapped) };
  }
  const members = unwrapped.types.filter((member) => !isNullishAst(member));
  const nullable = members.length < unwrapped.types.length;
  if (members.length === 1) {
    return { core: unwrapSuspend(members[0]!), nullable };
  }
  return { core: unwrapped, nullable };
}
