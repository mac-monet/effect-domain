import { SchemaAST } from "effect";

/**
 * Sentinel-based union member matching.
 *
 * The walker discriminates union values by "sentinels": required literal
 * properties (e.g. `_tag: "User"`) extracted from each member's encoded AST.
 * Earlier Effect v4 betas exposed this machinery as `SchemaAST.collectSentinels`
 * and `SchemaAST.getCandidates`; both are `@internal` as of 4.0.0-beta.97, so
 * the library owns a faithful port (MIT, from `effect`). Behavior notes:
 *
 * - Members with sentinels win by exact sentinel-value match.
 * - Members without sentinels fall back to runtime-type dispatch
 *   (`typeof`-style, with `null` and arrays distinguished).
 * - Literal members only match their own literal value.
 */

export interface Sentinel {
  readonly key: PropertyKey;
  readonly literal: unknown;
}

export function collectSentinels(ast: SchemaAST.AST): ReadonlyArray<Sentinel> {
  switch (ast._tag) {
    case "Objects":
      return ast.propertySignatures.flatMap((ps): ReadonlyArray<Sentinel> => {
        if (SchemaAST.isOptional(ps.type)) return [];
        if (SchemaAST.isLiteral(ps.type)) return [{ key: ps.name, literal: ps.type.literal }];
        if (SchemaAST.isUniqueSymbol(ps.type)) return [{ key: ps.name, literal: ps.type.symbol }];
        return [];
      });
    case "Arrays":
      return ast.elements.flatMap((element, index) =>
        SchemaAST.isLiteral(element) && !SchemaAST.isOptional(element)
          ? [{ key: index, literal: element.literal }]
          : [],
      );
    case "Suspend":
      return collectSentinels(ast.thunk());
    case "Declaration": {
      // Schema.Class stores its encoded form's sentinels on the declaration
      // annotations (upstream `~sentinels`), since the declaration itself has
      // no property signatures to scan.
      const sentinels = (ast.annotations as Record<string, unknown> | undefined)?.["~sentinels"];
      return Array.isArray(sentinels) ? (sentinels as ReadonlyArray<Sentinel>) : [];
    }
    default:
      return [];
  }
}

type RuntimeType =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "symbol"
  | "bigint"
  | "object"
  | "array"
  | "function";

const ALL_RUNTIME_TYPES: ReadonlyArray<RuntimeType> = [
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "symbol",
  "bigint",
  "object",
  "array",
  "function",
];

function candidateTypes(ast: SchemaAST.AST): ReadonlyArray<RuntimeType> {
  switch (ast._tag) {
    case "Null":
      return ["null"];
    case "Undefined":
      return ["undefined"];
    case "String":
    case "TemplateLiteral":
      return ["string"];
    case "Number":
      return ["number"];
    case "Boolean":
      return ["boolean"];
    case "Symbol":
    case "UniqueSymbol":
      return ["symbol"];
    case "BigInt":
      return ["bigint"];
    case "Arrays":
      return ["array"];
    case "ObjectKeyword":
      return ["object", "array", "function"];
    case "Objects":
      return ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0
        ? ["object"]
        : ["object", "array"];
    case "Enum":
      return Array.from(new Set(ast.enums.map(([, value]) => typeof value)));
    case "Literal":
      return [typeof ast.literal];
    case "Union":
      return Array.from(new Set(ast.types.flatMap(candidateTypes)));
    default:
      return ALL_RUNTIME_TYPES;
  }
}

interface CandidateIndex {
  readonly byType: ReadonlyMap<RuntimeType, ReadonlyArray<SchemaAST.AST>>;
  readonly bySentinel:
    | ReadonlyMap<PropertyKey, ReadonlyMap<unknown, ReadonlyArray<SchemaAST.AST>>>
    | undefined;
  readonly otherwise: ReadonlyMap<RuntimeType, ReadonlyArray<SchemaAST.AST>> | undefined;
}

const candidateIndexCache = new WeakMap<ReadonlyArray<SchemaAST.AST>, CandidateIndex>();

function push<K, V>(map: Map<K, Array<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function buildCandidateIndex(members: ReadonlyArray<SchemaAST.AST>): CandidateIndex {
  const byType = new Map<RuntimeType, Array<SchemaAST.AST>>();
  let bySentinel: Map<PropertyKey, Map<unknown, Array<SchemaAST.AST>>> | undefined;
  let otherwise: Map<RuntimeType, Array<SchemaAST.AST>> | undefined;

  for (const member of members) {
    const encoded = SchemaAST.toEncoded(member);
    if (SchemaAST.isNever(encoded)) continue;
    const types = candidateTypes(encoded);
    const sentinels = collectSentinels(encoded);

    for (const type of types) push(byType, type, member);

    if (sentinels.length > 0) {
      bySentinel ??= new Map();
      for (const { key, literal } of sentinels) {
        let byLiteral = bySentinel.get(key);
        if (!byLiteral) {
          byLiteral = new Map();
          bySentinel.set(key, byLiteral);
        }
        push(byLiteral, literal, member);
      }
    } else {
      otherwise ??= new Map();
      for (const type of types) push(otherwise, type, member);
    }
  }

  return { byType, bySentinel, otherwise };
}

function candidateIndex(members: ReadonlyArray<SchemaAST.AST>): CandidateIndex {
  const cached = candidateIndexCache.get(members);
  if (cached) return cached;
  const built = buildCandidateIndex(members);
  candidateIndexCache.set(members, built);
  return built;
}

function runtimeTypeOf(value: unknown): RuntimeType {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function matchesLiteral(value: unknown): (member: SchemaAST.AST) => boolean {
  return (member) => {
    const encoded = SchemaAST.toEncoded(member);
    if (SchemaAST.isLiteral(encoded)) return encoded.literal === value;
    if (SchemaAST.isUniqueSymbol(encoded)) return encoded.symbol === value;
    return true;
  };
}

function unionCandidates(
  value: unknown,
  members: ReadonlyArray<SchemaAST.AST>,
): ReadonlyArray<SchemaAST.AST> {
  const index = candidateIndex(members);
  const runtimeType = runtimeTypeOf(value);

  if (index.bySentinel) {
    const base = index.otherwise?.get(runtimeType) ?? [];
    if (runtimeType === "object" || runtimeType === "array") {
      const record = value as Record<PropertyKey, unknown>;
      for (const [key, byLiteral] of index.bySentinel) {
        if (!Object.hasOwn(record, key)) continue;
        const matched = byLiteral.get(record[key]);
        if (matched) return [...matched, ...base].filter(matchesLiteral(value));
      }
    }
    return base;
  }

  return (index.byType.get(runtimeType) ?? []).filter(matchesLiteral(value));
}

/**
 * Resolves the union member AST a runtime value belongs to, or `undefined`
 * when no member matches. Sentinel matches take precedence; the candidate
 * index is cached per union member array. When several members match (e.g.
 * duplicate sentinel values across variants), the first declared member wins
 * — same as upstream's candidate ordering.
 */
export function concreteUnionMember(
  value: unknown,
  union: SchemaAST.Union,
): SchemaAST.AST | undefined {
  return unionCandidates(value, union.types)[0];
}

/**
 * A union discriminator: a single property key present on every member with
 * a required literal value, where the literal values are pairwise distinct.
 *
 * `literals[i]` is member `i`'s literal for `key`, in the order the members
 * were passed.
 *
 * @since 0.2.0
 * @category models
 */
export interface UnionDiscriminator {
  readonly key: PropertyKey;
  readonly literals: ReadonlyArray<unknown>;
}

/**
 * Finds the discriminator key for a set of union member ASTs — the sentinel
 * key the walker would dispatch on. Returns `undefined` when no single key
 * discriminates every member (such a union cannot be walked or projected).
 *
 * Side-neutral: sentinels are read from the ASTs exactly as given. Pass
 * encoded-side members to mirror the walker's wire dispatch, or type-side
 * members to discriminate decoded runtime values. For plain literal tags the
 * two agree; a transformation on the tag property is the only way they can
 * differ.
 *
 * Walker-faithful: the candidate index dispatches a value on the FIRST
 * sentinel key it carries (`unionCandidates` iterates `bySentinel` in
 * insertion order), so the first key common to every member decides
 * dispatch outright. If that key's literals collide, the walker
 * misdispatches colliding members to the first one declared — the union is
 * not dispatchable, and this returns `undefined` rather than "skipping" to
 * a later key the walker would never consult. Keys sentinel-typed on only
 * some members are passed over (the walker falls through them per-value).
 *
 * @since 0.2.0
 * @category schema
 */
export function unionDiscriminator(
  members: ReadonlyArray<SchemaAST.AST>,
): UnionDiscriminator | undefined {
  const first = members[0];
  if (first === undefined) return undefined;
  const perMember = members.map(collectSentinels);
  for (const { key } of perMember[0]!) {
    const literals: Array<unknown> = [];
    for (const sentinels of perMember) {
      const match = sentinels.find((sentinel) => sentinel.key === key);
      if (match === undefined) break;
      literals.push(match.literal);
    }
    if (literals.length !== members.length) continue;
    return new Set(literals).size === literals.length ? { key, literals } : undefined;
  }
  return undefined;
}
