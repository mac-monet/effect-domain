import { SchemaAST } from "effect";
import {
  type AnyOperationDef,
  getFieldDefs,
  getNodeIdentity,
  type StoredFieldDef,
  type StoredIdentity,
} from "./define.ts";
import { isNullishAst, unwrapSuspend, unwrapType } from "./schema/ast.ts";
import { collectSentinels, type Sentinel } from "./schema/sentinels.ts";
import { rootPlan, type RootPlan } from "./selection/projection.ts";

/**
 * A reference edge from one registered node to another: the field through
 * which the target node is reachable, and how the path is wrapped.
 *
 * @since 0.2.0
 * @category models
 */
export interface NodeReference {
  readonly fieldName: string;
  readonly kind: "data" | "computed" | "batched";
  /** Canonical type AST of the referenced node (a key into `NodeRegistry.nodes`). */
  readonly target: SchemaAST.AST;
  /** The target is reached through one or more array wrappers. */
  readonly viaArray: boolean;
  /** The target is one member of a union at this field. */
  readonly viaUnion: boolean;
  /** The field is optional or its type admits null/undefined. */
  readonly optional: boolean;
}

/**
 * Everything the graph knows about one node type, extracted once from the
 * Schema AST at `Domain.make` time.
 *
 * @since 0.2.0
 * @category models
 */
export interface RegisteredNode {
  /** Canonical unwrapped node AST — the key in `NodeRegistry.nodes`. */
  readonly typeAst: SchemaAST.Objects;
  /** The `node()` identifier annotation ("User"), when present. */
  readonly identifier: string | undefined;
  /** Canonical entity-key extractor from `node()` options, when declared. */
  readonly identity: StoredIdentity | undefined;
  readonly fieldDefs: Readonly<Record<string, StoredFieldDef<unknown>>>;
  readonly dataFields: ReadonlyArray<{ readonly name: string; readonly type: SchemaAST.AST }>;
  /** Required literal properties of the encoded form, for union discrimination. */
  readonly sentinels: ReadonlyArray<Sentinel>;
  /** Edges to other registered nodes reachable through this node's fields. */
  readonly references: ReadonlyArray<NodeReference>;
}

/**
 * One graph operation as recorded by the registry.
 *
 * @since 0.2.0
 * @category models
 */
export interface RegisteredOperation {
  readonly name: string;
  readonly def: AnyOperationDef;
  readonly argsAst: SchemaAST.AST | null;
  readonly returnAst: SchemaAST.AST;
  /** Declared error schema AST — adapter metadata, never walked. */
  readonly errorAst: SchemaAST.AST | null;
  readonly stream: boolean;
}

/**
 * The normalized node registry built once per `Domain.make`. It is the single
 * product of Schema AST traversal: every other subsystem (plans, selection
 * schemas, response codecs, inspection, topology) consumes the registry
 * instead of re-walking raw AST.
 *
 * @since 0.2.0
 * @category models
 */
export interface NodeRegistry {
  /** Registered nodes keyed by canonical unwrapped type AST. */
  readonly nodes: ReadonlyMap<SchemaAST.AST, RegisteredNode>;
  readonly operations: ReadonlyArray<RegisteredOperation>;
  /**
   * Looks up a registered node, resolving suspend/type-side aliases to the
   * canonical AST. Returns `undefined` for unregistered ASTs (anonymous
   * structs, scalars) — callers must degrade to raw-AST handling.
   */
  readonly lookup: (ast: SchemaAST.AST) => RegisteredNode | undefined;
  /**
   * Classifies an operation-root AST (memoized per AST). The single root
   * classifier shared by the walker, response codecs, and selection schemas.
   */
  readonly rootPlanFor: (ast: SchemaAST.AST) => RootPlan;
  /**
   * Field defs for an AST when it resolves to a registered node, falling back
   * to the raw annotation resolve for unregistered object ASTs.
   */
  readonly fieldDefsFor: (
    ast: SchemaAST.AST,
  ) => Record<string, StoredFieldDef<unknown>> | undefined;
}

interface MutableRegisteredNode {
  typeAst: SchemaAST.Objects;
  identifier: string | undefined;
  identity: StoredIdentity | undefined;
  fieldDefs: Record<string, StoredFieldDef<unknown>>;
  dataFields: Array<{ name: string; type: SchemaAST.AST }>;
  sentinels: ReadonlyArray<Sentinel>;
  references: Array<NodeReference>;
}

export function buildRegistry(ops: Record<string, AnyOperationDef>): NodeRegistry {
  const nodes = new Map<SchemaAST.AST, MutableRegisteredNode>();
  const visited = new Set<SchemaAST.AST>();
  // Alias memo: any AST whose unwrapType resolves to a registered node maps
  // to that node, so lookups through Suspend/type-side wrappers are one get.
  const aliases = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

  // Phase 1: discover every registered node reachable from operation roots.
  // Recursion follows the *raw* AST wherever its shape matches the type-side
  // classification: toType strips encodings irrecoverably, and both sentinel
  // extraction (encoded-side discriminants) and recursion into children must
  // see raw ASTs to preserve them. `typeAst` is only the canonical key.
  function discover(ast: SchemaAST.AST): void {
    const typeAst = unwrapType(ast);
    if (ast !== typeAst) aliases.set(ast, typeAst);
    if (visited.has(typeAst)) return;
    visited.add(typeAst);

    const raw = SchemaAST.isSuspend(ast) ? unwrapSuspend(ast) : ast;

    if (SchemaAST.isUnion(typeAst)) {
      const src = SchemaAST.isUnion(raw) ? raw : typeAst;
      for (const member of src.types) discover(member);
      return;
    }

    if (SchemaAST.isArrays(typeAst)) {
      const src = SchemaAST.isArrays(raw) ? raw : typeAst;
      for (const item of src.rest) discover(item);
      for (const item of src.elements) discover(item);
      return;
    }

    if (SchemaAST.isObjects(typeAst)) {
      const src = SchemaAST.isObjects(raw) ? raw : typeAst;
      const fieldDefs = getFieldDefs(typeAst);
      if (fieldDefs && !nodes.has(typeAst)) {
        const computedNames = new Set(Object.keys(fieldDefs));
        const dataFields: Array<{ name: string; type: SchemaAST.AST }> = [];
        for (const ps of typeAst.propertySignatures) {
          if (typeof ps.name === "string" && !computedNames.has(ps.name)) {
            dataFields.push({ name: ps.name, type: ps.type });
          }
        }
        nodes.set(typeAst, {
          typeAst,
          identifier: SchemaAST.resolveAt<string>("identifier")(typeAst),
          identity: getNodeIdentity(typeAst),
          fieldDefs,
          dataFields,
          sentinels: collectSentinels(SchemaAST.toEncoded(src)),
          references: [],
        });
        for (const def of Object.values(fieldDefs)) {
          // Stored field def types are raw schemas as passed to field().
          discover(def.type.ast);
          if (def._kind === "computed" && def.args) {
            discover(def.args.ast);
          }
        }
      }
      for (const ps of src.propertySignatures) {
        discover(ps.type);
      }
    }
  }

  // Only operation return types seed discovery: `inspect().nodes` and the
  // topology describe the output model. Field-level computed args are walked
  // (parity with the pre-registry inspect), operation args are not.
  for (const op of Object.values(ops)) {
    discover(op.type.ast);
  }

  // Phase 2: resolve reference edges now that all nodes are known (handles
  // forward and recursive references).
  let nextAstId = 0;
  const astIds = new WeakMap<SchemaAST.AST, number>();
  function astKey(ast: SchemaAST.AST): number {
    let id = astIds.get(ast);
    if (id === undefined) {
      id = nextAstId++;
      astIds.set(ast, id);
    }
    return id;
  }
  interface TargetHit {
    readonly target: SchemaAST.AST;
    readonly viaArray: boolean;
    readonly viaUnion: boolean;
    readonly optional: boolean;
  }

  function collectTargets(
    ast: SchemaAST.AST,
    viaArray: boolean,
    viaUnion: boolean,
    optional: boolean,
    out: Array<TargetHit>,
    // Cycle guard keyed on (canonical AST, wrapper flags): the same target
    // reachable both directly and through an array/union wrapper must record
    // both edges (e.g. `Schema.Union([Post, Schema.Array(Post)])`).
    seen: Set<string>,
  ): void {
    const typeAst = unwrapType(ast);
    const seenKey = `${astKey(typeAst)}|${viaArray}|${viaUnion}|${optional}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    if (isNullishAst(typeAst)) return;

    if (SchemaAST.isUnion(typeAst)) {
      const hasNullish = typeAst.types.some((member) => isNullishAst(unwrapType(member)));
      for (const member of typeAst.types) {
        collectTargets(member, viaArray, true, optional || hasNullish, out, seen);
      }
      return;
    }

    if (SchemaAST.isArrays(typeAst)) {
      for (const item of typeAst.rest) collectTargets(item, true, viaUnion, optional, out, seen);
      for (const item of typeAst.elements) {
        collectTargets(item, true, viaUnion, optional, out, seen);
      }
      return;
    }

    if (SchemaAST.isObjects(typeAst)) {
      if (nodes.has(typeAst)) {
        out.push({ target: typeAst, viaArray, viaUnion, optional });
        return;
      }
      // Anonymous struct: recurse so nodes nested inside it still produce an
      // edge (attributed to the outer field).
      for (const ps of typeAst.propertySignatures) {
        collectTargets(ps.type, viaArray, viaUnion, optional, out, seen);
      }
    }
  }

  for (const entry of nodes.values()) {
    const addReferences = (
      fieldName: string,
      kind: NodeReference["kind"],
      fieldAst: SchemaAST.AST,
      fieldOptional: boolean,
    ) => {
      const hits: Array<TargetHit> = [];
      collectTargets(fieldAst, false, false, fieldOptional, hits, new Set());
      for (const hit of hits) {
        entry.references.push({ fieldName, kind, ...hit });
      }
    };

    for (const dataField of entry.dataFields) {
      addReferences(dataField.name, "data", dataField.type, SchemaAST.isOptional(dataField.type));
    }
    for (const [name, def] of Object.entries(entry.fieldDefs)) {
      addReferences(name, def._kind, def.type.ast, false);
    }
  }

  const operations: Array<RegisteredOperation> = Object.entries(ops).map(([name, def]) => ({
    name,
    def,
    argsAst: def.args ? def.args.ast : null,
    returnAst: def.type.ast,
    errorAst: def.error ? def.error.ast : null,
    stream: def._stream,
  }));

  const frozen: ReadonlyMap<SchemaAST.AST, RegisteredNode> = nodes;

  function lookup(ast: SchemaAST.AST): RegisteredNode | undefined {
    const direct = frozen.get(ast);
    if (direct) return direct;
    const alias = aliases.get(ast);
    if (alias) return frozen.get(alias);
    // Unknown AST: resolve once and memoize the alias for future lookups.
    const typeAst = unwrapType(ast);
    aliases.set(ast, typeAst);
    return frozen.get(typeAst);
  }

  return {
    nodes: frozen,
    operations,
    lookup,
    // Root plans and field defs are pure per-AST derivations; the registry is
    // their owner at the API level while memoization stays shared across
    // graphs (spread-merged graphs reference the same node ASTs).
    rootPlanFor: rootPlan,
    fieldDefsFor: (ast) => {
      const registered = lookup(ast);
      if (registered) return registered.fieldDefs as Record<string, StoredFieldDef<unknown>>;
      const typeAst = unwrapType(ast);
      return SchemaAST.isObjects(typeAst) ? getFieldDefs(typeAst) : undefined;
    },
  };
}
