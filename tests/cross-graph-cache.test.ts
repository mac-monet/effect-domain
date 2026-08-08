import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation } from "../src/index.ts";

// Executable pin for the cross-graph cache-purity invariant.
//
// selection/schema.ts and response/codec.ts cache derived codecs in
// module-global WeakMaps keyed by AST identity, shared across every domain
// that references the same node AST. That is sound only while every
// registry-derived answer the builders consume (fieldDefsFor, sentinels,
// rootPlanFor) is a pure function of the AST. If a future change makes any
// registry answer vary per graph (per-graph field overrides, registry-level
// config), a codec built through one graph's registry would be served to
// another graph — and these identity assertions fail loudly instead of the
// bug shipping silently.

const User = node(
  "CrossGraphUser",
  Schema.Struct({ id: Schema.String, name: Schema.String }),
  (f) => ({
    shout: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(parent.name.toUpperCase()),
    }),
  }),
);

const domainA = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) => Effect.succeed({ id: args.id, name: "Alice" }),
  }),
});

const domainB = Domain.make({
  fetchUser: operation({
    type: User,
    resolve: () => Effect.succeed({ id: "2", name: "Bob" }),
  }),
});

describe("cross-graph codec cache purity", () => {
  it("two domains sharing a node AST share the selection codec by identity", () => {
    expect(domainA.selectionSchema("getUser")).toBe(domainB.selectionSchema("fetchUser"));
  });

  it("two domains sharing a node AST share the response codec by identity", () => {
    const a = domainA.responseSchema("getUser", { id: true, shout: true });
    const b = domainB.responseSchema("fetchUser", { id: true, shout: true });
    expect(a).toBe(b);
  });

  it("structurally equal selections share one response codec across key order", () => {
    const a = domainA.responseSchema("getUser", { id: true, shout: true });
    const b = domainB.responseSchema("fetchUser", { shout: true, id: true });
    expect(a).toBe(b);
  });
});
