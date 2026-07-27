import { Effect, Graph as EffectGraph, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation } from "../src/index.ts";

const User = node(
  "User",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
  {},
  { identity: "id" },
);

const Post = node(
  "Post",
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    authorId: Schema.String,
  }),
  (f) => ({
    author: f.field({
      type: User,
      key: (parent) => parent.authorId,
      resolve: (keys: ReadonlyArray<string>) =>
        Effect.succeed(new Map(keys.map((k) => [k, { id: k, name: "A" } as never]))),
    }),
  }),
);

const Blog = node(
  "Blog",
  Schema.Struct({
    id: Schema.String,
    posts: Schema.Array(Post),
    owner: User,
  }),
  {},
);

const domain = Domain.make({
  getBlog: operation({
    type: Blog,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.succeed({ id: args.id, posts: [], owner: { id: "1", name: "O" } }),
  }),
});

describe("domain.topology()", () => {
  it("exposes one node per registered node and one edge per reference", () => {
    const topology = domain.topology();
    expect(EffectGraph.nodeCount(topology.graph)).toBe(3);
    // Blog -> Post (posts), Blog -> User (owner), Post -> User (author)
    expect(EffectGraph.edgeCount(topology.graph)).toBe(3);
  });

  it("resolves identifiers to node indices with correct node data", () => {
    const topology = domain.topology();
    const userIndex = topology.nodeIndex("User")!;
    expect(userIndex).toBeDefined();
    const userInfo = EffectGraph.getNode(topology.graph, userIndex);
    expect(userInfo._tag).toBe("Some");
    if (userInfo._tag === "Some") {
      expect(userInfo.value.identifier).toBe("User");
      expect(userInfo.value.identityField).toBe("id");
      expect(userInfo.value.hasIdentity).toBe(true);
    }
    expect(topology.nodeIndex("Nope")).toBeUndefined();
  });

  it("carries field edge data with wrapper flags", () => {
    const topology = domain.topology();
    const blog = topology.nodeIndex("Blog")!;
    const edges = Array.from(EffectGraph.values(EffectGraph.edges(topology.graph))).filter(
      (edge) => edge.source === blog,
    );
    const posts = edges.find((edge) => edge.data.fieldName === "posts")!;
    expect(posts.data.kind).toBe("data");
    expect(posts.data.viaArray).toBe(true);
    const owner = edges.find((edge) => edge.data.fieldName === "owner")!;
    expect(owner.data.viaArray).toBe(false);
  });

  it("supports core Graph algorithms on the topology", () => {
    const topology = domain.topology();
    const blog = topology.nodeIndex("Blog")!;
    const user = topology.nodeIndex("User")!;
    // User is reachable from Blog
    const reachable = Array.from(
      EffectGraph.indices(EffectGraph.dfs(topology.graph, { start: [blog] })),
    );
    expect(reachable).toContain(user);
    expect(EffectGraph.isAcyclic(topology.graph)).toBe(true);
  });

  it("exports Mermaid and GraphViz diagrams", () => {
    const topology = domain.topology();
    const mermaid = topology.toMermaid();
    expect(mermaid).toContain("flowchart");
    expect(mermaid).toContain("User");
    // Mermaid escapes brackets in labels: posts[] -> posts#91;#93;
    expect(mermaid).toContain("posts#91;#93;");
    const dot = topology.toGraphViz();
    expect(dot).toContain("digraph");
    expect(dot).toContain("User");
  });

  it("is memoized per domain and shared across provide()", () => {
    const first = domain.topology();
    expect(domain.topology()).toBe(first);
  });
});
