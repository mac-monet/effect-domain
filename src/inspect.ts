import type { SchemaAST } from "effect";
import type { NodeRegistry, RegisteredNode } from "./registry.ts";

/**
 * Structured description of a graph — its operations and every node
 * reachable from them — as returned by `graph.inspect()`. A read-only
 * projection of the graph's node registry, for adapter schema generation
 * (GraphQL types, OpenAPI specs), documentation, and dev tools.
 *
 * @since 0.1.0
 * @category models
 */
export interface Inspection {
  readonly operations: ReadonlyArray<OperationInfo>;
  readonly nodes: ReadonlyArray<NodeInfo>;
}

/**
 * One operation: name, args AST (`null` when the operation takes none),
 * root type AST, and whether it streams.
 *
 * @since 0.1.0
 * @category models
 */
export interface OperationInfo {
  readonly name: string;
  readonly args: SchemaAST.AST | null;
  readonly returnType: SchemaAST.AST;
  /** Declared error schema AST, when the operation provides one. */
  readonly error: SchemaAST.AST | null;
  readonly stream: boolean;
}

/**
 * One graph node discovered from the operation types: its `node()`
 * identifier, type AST, the split between plain data fields and
 * computed/batched fields, and its declared entity identity (when any).
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeInfo {
  readonly identifier: string | undefined;
  readonly type: SchemaAST.AST;
  readonly dataFields: ReadonlyArray<DataFieldInfo>;
  readonly computedFields: ReadonlyArray<ComputedFieldInfo>;
  /** Data field designated as the entity key, when `identity` was a field name. */
  readonly identityField: string | undefined;
  /** Whether the node declares an entity identity (field or function form). */
  readonly hasIdentity: boolean;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface DataFieldInfo {
  readonly name: string;
  readonly type: SchemaAST.AST;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ComputedFieldInfo {
  readonly name: string;
  readonly kind: "computed" | "batched";
  readonly args: SchemaAST.AST | null;
  readonly type: SchemaAST.AST;
}

export function inspect(registry: NodeRegistry): Inspection {
  return {
    operations: registry.operations.map(
      (op): OperationInfo => ({
        name: op.name,
        args: op.argsAst,
        returnType: op.returnAst,
        error: op.errorAst,
        stream: op.stream,
      }),
    ),
    nodes: Array.from(registry.nodes.values(), buildNodeInfo),
  };
}

export function buildNodeInfo(node: RegisteredNode): NodeInfo {
  const computedFields: Array<ComputedFieldInfo> = Object.entries(node.fieldDefs).map(
    ([name, def]) =>
      def._kind === "batched"
        ? { name, kind: "batched", args: null, type: def.type.ast }
        : { name, kind: "computed", args: def.args ? def.args.ast : null, type: def.type.ast },
  );
  return {
    identifier: node.identifier,
    type: node.typeAst,
    dataFields: node.dataFields,
    computedFields,
    identityField: node.identity?.field,
    hasIdentity: node.identity !== undefined,
  };
}
