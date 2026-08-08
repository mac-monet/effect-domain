import { type Schema, SchemaAST } from "effect";
import {
  type AnyOperationDef,
  getFieldDefs,
  getNodeIdentity,
  type StoredFieldDef,
  type StoredIdentity,
} from "./define.ts";
import { isNullishAst, unwrapSuspend } from "./schema/ast.ts";
import { collectSentinels, type Sentinel } from "./schema/sentinels.ts";
import { rootPlan, type RootPlan } from "./selection/projection.ts";

/**
 * A reference edge from one registered node to another: the field through
 * which the target node is reachable, and how the path is wrapped.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeReference {
  readonly fieldName: string;
  readonly kind: "data" | "computed" | "batched";
  /** Canonical raw AST of the referenced node (a key into `NodeRegistry.nodes`). */
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
 * @since 0.1.0
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
 * @since 0.1.0
 * @category models
 */
export interface RegisteredOperation {
  readonly name: string;
  readonly def: AnyOperationDef;
  readonly argsAst: SchemaAST.AST | null;
  readonly returnAst: SchemaAST.AST;
  /** Declared error schema AST — adapter metadata, discovered but never walked. */
  readonly errorAst: SchemaAST.AST | null;
  readonly stream: boolean;
}

/**
 * The normalized node registry built once per `Domain.make`. It is the single
 * product of Schema AST traversal: every other subsystem (plans, selection
 * schemas, response codecs, inspection, topology) consumes the registry
 * instead of re-walking raw AST.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeRegistry {
  /** Registered nodes keyed by canonical unwrapped raw AST. */
  readonly nodes: ReadonlyMap<SchemaAST.AST, RegisteredNode>;
  readonly operations: ReadonlyArray<RegisteredOperation>;
  /**
   * Looks up a registered node, resolving Suspend wrappers to the canonical
   * raw AST. Returns `undefined` for unregistered ASTs (anonymous structs,
   * scalars) — callers must degrade to raw-AST handling.
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

/**
 * Declared error schemas of every computed field reachable from an operation
 * root: the root's node(s) plus everything transitively referenced through
 * their fields. A field's typed failure fails the whole operation (strict
 * walk semantics), so wire handlers union these into the operation's failure
 * codec. Deduplicated by schema identity; cycle-safe via the reference graph.
 *
 * @since 0.2.0
 * @category accessors
 */
export function reachableFieldErrorSchemas(
  registry: NodeRegistry,
  rootAst: SchemaAST.AST,
): ReadonlyArray<Schema.Top> {
  const out: Array<Schema.Top> = [];
  const seenSchemas = new Set<Schema.Top>();
  const seenNodes = new Set<RegisteredNode>();

  function visitNode(node: RegisteredNode | undefined): void {
    if (!node || seenNodes.has(node)) return;
    seenNodes.add(node);
    for (const def of Object.values(node.fieldDefs)) {
      if (def.error !== undefined && !seenSchemas.has(def.error)) {
        seenSchemas.add(def.error);
        out.push(def.error);
      }
    }
    for (const ref of node.references) {
      visitNode(registry.nodes.get(ref.target));
    }
  }

  // Seed: unwrap suspends and walk arrays/unions at the root until registered
  // nodes appear. Raw ASTs have stable identity so the cycle guard converges.
  function seed(ast: SchemaAST.AST, guard: Set<SchemaAST.AST>): void {
    const unwrapped = unwrapSuspend(ast);
    if (guard.has(unwrapped)) return;
    guard.add(unwrapped);
    const registered = registry.lookup(unwrapped);
    if (registered) {
      visitNode(registered);
      return;
    }
    if (SchemaAST.isUnion(unwrapped)) {
      for (const member of unwrapped.types) seed(member, guard);
      return;
    }
    if (SchemaAST.isArrays(unwrapped)) {
      for (const item of unwrapped.rest) seed(item, guard);
      for (const item of unwrapped.elements) seed(item, guard);
      return;
    }
    if (SchemaAST.isObjects(unwrapped)) {
      // Anonymous struct root: nodes may nest inside its properties.
      for (const ps of unwrapped.propertySignatures) seed(ps.type, guard);
    }
  }

  seed(rootAst, new Set());
  return out;
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
  // Alias memo: any AST whose unwrapSuspend resolves to a registered node
  // maps to that node, so lookups through Suspend wrappers are one get.
  const aliases = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

  // Phase 1: discover every registered node reachable from operation roots.
  // Recursion and keying share one domain: the raw AST. In Effect v4's
  // type-primary model the raw AST already carries type-side structure, so
  // unwrapSuspend is the only canonicalization needed. Sentinel extraction
  // reads the encoded side via `toEncoded` (correct for wire discrimination).
  function discover(ast: SchemaAST.AST): void {
    const unwrapped = unwrapSuspend(ast);
    if (ast !== unwrapped) aliases.set(ast, unwrapped);
    if (visited.has(unwrapped)) return;
    visited.add(unwrapped);

    if (SchemaAST.isUnion(unwrapped)) {
      for (const member of unwrapped.types) discover(member);
      return;
    }

    if (SchemaAST.isArrays(unwrapped)) {
      for (const item of unwrapped.rest) discover(item);
      for (const item of unwrapped.elements) discover(item);
      return;
    }

    if (SchemaAST.isObjects(unwrapped)) {
      const fieldDefs = getFieldDefs(unwrapped);
      if (fieldDefs && !nodes.has(unwrapped)) {
        const computedNames = new Set(Object.keys(fieldDefs));
        const dataFields: Array<{ name: string; type: SchemaAST.AST }> = [];
        for (const ps of unwrapped.propertySignatures) {
          if (typeof ps.name === "string" && !computedNames.has(ps.name)) {
            dataFields.push({ name: ps.name, type: ps.type });
          }
        }
        nodes.set(unwrapped, {
          typeAst: unwrapped,
          identifier: SchemaAST.resolveAt<string>("identifier")(unwrapped),
          identity: getNodeIdentity(unwrapped),
          fieldDefs,
          dataFields,
          sentinels: collectSentinels(SchemaAST.toEncoded(unwrapped)),
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
      for (const ps of unwrapped.propertySignatures) {
        discover(ps.type);
      }
    }
  }

  // Operation return types and declared error schemas seed discovery:
  // `inspect().nodes` and the topology describe the output model, and error
  // variants can nest registered nodes that appear nowhere else. Field-level
  // computed args are walked (parity with the pre-registry inspect),
  // operation args are not.
  for (const op of Object.values(ops)) {
    discover(op.type.ast);
    if (op.error) discover(op.error.ast);
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
    const unwrapped = unwrapSuspend(ast);
    const seenKey = `${astKey(unwrapped)}|${viaArray}|${viaUnion}|${optional}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    if (isNullishAst(unwrapped)) return;

    if (SchemaAST.isUnion(unwrapped)) {
      const hasNullish = unwrapped.types.some((member) => isNullishAst(unwrapSuspend(member)));
      for (const member of unwrapped.types) {
        collectTargets(member, viaArray, true, optional || hasNullish, out, seen);
      }
      return;
    }

    if (SchemaAST.isArrays(unwrapped)) {
      for (const item of unwrapped.rest) collectTargets(item, true, viaUnion, optional, out, seen);
      for (const item of unwrapped.elements) {
        collectTargets(item, true, viaUnion, optional, out, seen);
      }
      return;
    }

    if (SchemaAST.isObjects(unwrapped)) {
      if (nodes.has(unwrapped)) {
        out.push({ target: unwrapped, viaArray, viaUnion, optional });
        return;
      }
      // Anonymous struct: recurse so nodes nested inside it still produce an
      // edge (attributed to the outer field).
      for (const ps of unwrapped.propertySignatures) {
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
    const unwrapped = unwrapSuspend(ast);
    aliases.set(ast, unwrapped);
    return frozen.get(unwrapped);
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
      const unwrapped = unwrapSuspend(ast);
      return SchemaAST.isObjects(unwrapped) ? getFieldDefs(unwrapped) : undefined;
    },
  };
}
