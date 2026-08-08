import { Graph as EffectGraph, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { domain } from "./domain.ts";

function decodeOk(schema: unknown, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
}

function decodeFails(schema: unknown, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
    return false;
  } catch (error) {
    // A schema rejection, not an arbitrary defect.
    return (error as { _tag?: string })._tag === "SchemaError";
  }
}

describe("kitchen sink: argsSchema", () => {
  it("decodes valid args and rejects malformed ones", () => {
    const schema = domain.argsSchema("getUser");
    expect(decodeOk(schema, { id: "u1" })).toEqual({ id: "u1" });
    expect(decodeFails(schema, { id: 42 })).toBe(true);
    expect(decodeFails(schema, {})).toBe(true);
  });

  it("no-args operations use Schema.Void", () => {
    expect(decodeOk(domain.argsSchema("countUsers"), undefined)).toBeUndefined();
  });
});

describe("kitchen sink: selectionSchema", () => {
  it("rejects an omitted selection for a node root", () => {
    expect(decodeFails(domain.selectionSchema("getUser"), undefined)).toBe(true);
  });

  it("accepts a deep cyclic selection and rejects unknown keys at depth 3", () => {
    const schema = domain.selectionSchema("getUser");
    const deep = {
      id: true,
      posts: {
        select: {
          title: true,
          author: { select: { fullName: true } },
          comments: { select: { body: true } },
        },
      },
    };
    expect(decodeOk(schema, deep)).toEqual(deep);
    expect(
      decodeFails(schema, {
        posts: { select: { comments: { select: { bogus: true } } } },
      }),
    ).toBe(true);
  });

  it("scalar roots accept only an omitted selection", () => {
    const schema = domain.selectionSchema("countUsers");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, {})).toBe(true);
  });
});

describe("kitchen sink: responseSchema", () => {
  it("decodes a deep response with nullable editor and array-of-node comments", () => {
    const selection = decodeOk(domain.selectionSchema("getUser"), {
      fullName: true,
      posts: {
        select: {
          editor: { select: { id: true } },
          comments: { select: { body: true } },
        },
      },
    });
    const schema = domain.responseSchema("getUser", selection as never);

    const decoded = decodeOk(schema, {
      fullName: "Ada Lovelace",
      posts: [
        { editor: { id: "u2" }, comments: [{ body: "Nice" }] },
        { editor: null, comments: [] },
      ],
    }) as { posts: ReadonlyArray<{ editor: unknown }> };

    expect(decoded.posts[0]!.editor).toEqual({ id: "u2" });
    expect(decoded.posts[1]!.editor).toBeNull();
    expect(decodeFails(schema, { fullName: 42, posts: [] })).toBe(true);
    // Nested validation: bad editor.id and bad comments[].body at depth.
    expect(
      decodeFails(schema, {
        fullName: "Ada Lovelace",
        posts: [{ editor: { id: 42 }, comments: [] }],
      }),
    ).toBe(true);
    expect(
      decodeFails(schema, {
        fullName: "Ada Lovelace",
        posts: [{ editor: null, comments: [{ body: 42 }] }],
      }),
    ).toBe(true);
  });

  it("exports args as a JSON Schema document", () => {
    const doc = Schema.toJsonSchemaDocument(domain.argsSchema("getUser"));
    expect(doc.schema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });
});

describe("kitchen sink: inspect and topology on the cyclic graph", () => {
  it("inspect lists every reachable node and the declared operation error", () => {
    const inspection = domain.inspect();
    const ids = inspection.nodes
      .map((n) => String(n.identifier))
      .sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(["KSComment", "KSFeed", "KSPost", "KSTag", "KSUser"]);

    const ops = new Map(inspection.operations.map((op) => [op.name, op]));
    expect(ops.get("getUser")!.error).not.toBeNull();
    expect(ops.get("countUsers")!.error).toBeNull();
    expect(ops.has("watchPosts")).toBe(false);
    expect(inspection.subscriptions.map((op) => op.name)).toEqual(["watchPosts"]);

    const user = inspection.nodes.find((n) => n.identifier === "KSUser")!;
    const kinds = new Map(user.computedFields.map((c) => [c.name, c.kind]));
    expect(kinds.get("fullName")).toBe("computed");
    expect(kinds.get("posts")).toBe("batched");
  });

  it("topology terminates on the cycle and exports diagrams naming every node", () => {
    const topology = domain.topology();
    expect(EffectGraph.nodeCount(topology.graph)).toBe(5);
    expect(EffectGraph.isAcyclic(topology.graph)).toBe(false);

    // Core Graph traversal does not infinite-loop on User -> Post -> User.
    const user = topology.nodeIndex("KSUser")!;
    const post = topology.nodeIndex("KSPost")!;
    const reachable = Array.from(
      EffectGraph.indices(EffectGraph.dfs(topology.graph, { start: [user] })),
    );
    expect(reachable).toContain(post);

    const mermaid = topology.toMermaid();
    for (const name of ["KSUser", "KSPost", "KSComment", "KSFeed", "KSTag"]) {
      expect(mermaid).toContain(name);
    }
    expect(typeof mermaid).toBe("string");
  });
});
