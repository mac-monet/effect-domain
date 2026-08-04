import { Graph as EffectGraph } from "effect";
import { buildNodeInfo, type NodeInfo } from "../inspect.ts";
import type { NodeRegistry } from "../registry.ts";

/**
 * Edge data in the graph topology: the field through which one node
 * references another, and how the reference is wrapped.
 *
 * @since 0.1.0
 * @category models
 */
export interface FieldEdge {
  readonly fieldName: string;
  readonly kind: "data" | "computed" | "batched";
  readonly viaArray: boolean;
  readonly viaUnion: boolean;
  readonly optional: boolean;
}

/**
 * The graph's domain topology as a core `effect/Graph` value: one node per
 * registered `node()`, one edge per field reference between nodes. A
 * composable interchange surface for adapters — traversal algorithms,
 * `Equal`/`Hash`, and diagram export come from the core Domain module.
 *
 * @since 0.1.0
 * @category models
 */
export interface DomainTopology {
  readonly graph: EffectGraph.DirectedGraph<NodeInfo, FieldEdge>;
  /**
   * Resolves a `node()` identifier ("User") to its index in `graph`.
   * Identifiers are not enforced unique: with duplicates, the first node in
   * discovery order wins here — all nodes remain present in `graph`.
   */
  nodeIndex(identifier: string): EffectGraph.NodeIndex | undefined;
  toMermaid(options?: { readonly direction?: EffectGraph.MermaidDirection }): string;
  toGraphViz(): string;
}

export function buildTopology(registry: NodeRegistry): DomainTopology {
  const indexByAst = new Map<unknown, EffectGraph.NodeIndex>();
  const indexByIdentifier = new Map<string, EffectGraph.NodeIndex>();

  // Single mutation scope: effect/Graph is copy-on-mutate, so nodes and edges
  // are added in one directed() build and the graph is never mutated after.
  const graph = EffectGraph.directed<NodeInfo, FieldEdge>((mutable) => {
    for (const node of registry.nodes.values()) {
      const index = EffectGraph.addNode(mutable, buildNodeInfo(node));
      indexByAst.set(node.typeAst, index);
      if (node.identifier !== undefined && !indexByIdentifier.has(node.identifier)) {
        indexByIdentifier.set(node.identifier, index);
      }
    }
    for (const node of registry.nodes.values()) {
      const source = indexByAst.get(node.typeAst)!;
      for (const ref of node.references) {
        const target = indexByAst.get(ref.target);
        if (target === undefined) continue;
        EffectGraph.addEdge(mutable, source, target, {
          fieldName: ref.fieldName,
          kind: ref.kind,
          viaArray: ref.viaArray,
          viaUnion: ref.viaUnion,
          optional: ref.optional,
        });
      }
    }
  });

  return {
    graph,
    nodeIndex(identifier: string) {
      return indexByIdentifier.get(identifier);
    },
    toMermaid(options) {
      return EffectGraph.toMermaid(graph, {
        ...(options?.direction !== undefined ? { direction: options.direction } : {}),
        nodeLabel: (node) => node.identifier ?? "<anonymous>",
        edgeLabel: (edge) => (edge.viaArray ? `${edge.fieldName}[]` : edge.fieldName),
      });
    },
    toGraphViz() {
      return EffectGraph.toGraphViz(graph, {
        nodeLabel: (node) => node.identifier ?? "<anonymous>",
        edgeLabel: (edge) => (edge.viaArray ? `${edge.fieldName}[]` : edge.fieldName),
      });
    },
  };
}
