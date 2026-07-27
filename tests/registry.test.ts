import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { node, operation } from "../src/index.ts";
import { buildRegistry } from "../src/registry.ts";

const User = node(
  "User",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
  }),
  (f) => ({
    fullName: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
  }),
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
        Effect.succeed(
          new Map(keys.map((k) => [k, { id: k, firstName: "A", lastName: "B" } as never])),
        ),
    }),
  }),
);

const Feed = node(
  "Feed",
  Schema.Struct({
    id: Schema.String,
    posts: Schema.Array(Post),
    pinned: Schema.NullOr(Post),
  }),
  {},
  { identity: (feed) => `feed:${feed.id}` },
);

const getFeed = operation({
  type: Feed,
  args: Schema.Struct({ id: Schema.String }),
  resolve: ({ args }) => Effect.succeed({ id: args.id, posts: [], pinned: null }),
});

describe("buildRegistry", () => {
  it("discovers all nodes reachable from operation roots", () => {
    const registry = buildRegistry({ getFeed });
    const identifiers = Array.from(registry.nodes.values())
      .map((n) => n.identifier ?? "")
      .sort((a, b) => a.localeCompare(b));
    expect(identifiers).toEqual(["Feed", "Post", "User"]);
  });

  it("splits data fields from computed field defs", () => {
    const registry = buildRegistry({ getFeed });
    const user = Array.from(registry.nodes.values()).find((n) => n.identifier === "User")!;
    expect(user.dataFields.map((f) => f.name).sort()).toEqual(["firstName", "id", "lastName"]);
    expect(Object.keys(user.fieldDefs)).toEqual(["fullName"]);
  });

  it("records reference edges with wrapper flags", () => {
    const registry = buildRegistry({ getFeed });
    const feed = Array.from(registry.nodes.values()).find((n) => n.identifier === "Feed")!;
    const posts = feed.references.find((r) => r.fieldName === "posts")!;
    expect(posts.kind).toBe("data");
    expect(posts.viaArray).toBe(true);
    expect(posts.optional).toBe(false);

    const pinned = feed.references.find((r) => r.fieldName === "pinned")!;
    expect(pinned.viaUnion).toBe(true);
    expect(pinned.optional).toBe(true);

    const post = Array.from(registry.nodes.values()).find((n) => n.identifier === "Post")!;
    const author = post.references.find((r) => r.fieldName === "author")!;
    expect(author.kind).toBe("batched");
    expect(author.viaArray).toBe(false);
  });

  it("stores node identity: key-field form and function form", () => {
    const registry = buildRegistry({ getFeed });
    const user = Array.from(registry.nodes.values()).find((n) => n.identifier === "User")!;
    expect(user.identity?.field).toBe("id");
    expect(user.identity?.extract({ id: "42" })).toBe("42");

    const feed = Array.from(registry.nodes.values()).find((n) => n.identifier === "Feed")!;
    expect(feed.identity?.field).toBeUndefined();
    expect(feed.identity?.extract({ id: "7" })).toBe("feed:7");

    const post = Array.from(registry.nodes.values()).find((n) => n.identifier === "Post")!;
    expect(post.identity).toBeUndefined();
  });

  it("registers recursive schemas once and resolves suspend aliases", () => {
    interface CategoryShape {
      readonly id: string;
      readonly children: ReadonlyArray<CategoryShape>;
    }
    const CategoryStruct = Schema.Struct({
      id: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Schema<CategoryShape> => Category)),
    });
    const Category: Schema.Schema<CategoryShape> = node("Category", CategoryStruct, {}) as never;

    const getCategory = operation({
      type: Category,
      resolve: () => Effect.succeed({ id: "root", children: [] }),
    });

    const registry = buildRegistry({ getCategory });
    const categories = Array.from(registry.nodes.values()).filter(
      (n) => n.identifier === "Category",
    );
    expect(categories).toHaveLength(1);

    const category = categories[0]!;
    const childRef = category.references.find((r) => r.fieldName === "children")!;
    expect(childRef.target).toBe(category.typeAst);
    expect(childRef.viaArray).toBe(true);

    // Lookup through the raw operation root AST resolves to the same node.
    expect(registry.lookup(getCategory.type.ast)).toBe(category);
  });

  it("does not register anonymous structs without field defs", () => {
    const getStats = operation({
      type: Schema.Struct({ count: Schema.Number }),
      resolve: () => Effect.succeed({ count: 1 }),
    });
    const registry = buildRegistry({ getStats });
    expect(registry.nodes.size).toBe(0);
    expect(registry.lookup(getStats.type.ast)).toBeUndefined();
  });

  it("records both edges when a target is reachable direct and array-wrapped", () => {
    const Wrapper = node(
      "Wrapper",
      Schema.Struct({
        id: Schema.String,
        item: Schema.Union([Post, Schema.Array(Post)]),
      }),
      {},
    );
    const getWrapper = operation({
      type: Wrapper,
      resolve: () => Effect.succeed({ id: "1", item: [] }),
    });
    const registry = buildRegistry({ getWrapper });
    const wrapper = Array.from(registry.nodes.values()).find((n) => n.identifier === "Wrapper")!;
    const itemEdges = wrapper.references.filter((r) => r.fieldName === "item");
    expect(itemEdges.map((r) => r.viaArray).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
  });

  it("emits edges for nodes nested inside anonymous structs", () => {
    const Holder = node(
      "Holder",
      Schema.Struct({
        id: Schema.String,
        wrapped: Schema.Struct({ user: User }),
      }),
      {},
    );
    const getHolder = operation({
      type: Holder,
      resolve: () => Effect.succeed({ id: "1", wrapped: { user: { id: "u" } } }) as never,
    });
    const registry = buildRegistry({ getHolder });
    const holder = Array.from(registry.nodes.values()).find((n) => n.identifier === "Holder")!;
    const edge = holder.references.find((r) => r.fieldName === "wrapped");
    expect(edge).toBeDefined();
    expect(registry.lookup(User.ast)).toBeDefined();
  });

  it("extracts encoded-side sentinels for renamed discriminants", () => {
    const Renamed = node(
      "Renamed",
      Schema.Struct({
        _tag: Schema.Literal("renamed"),
        id: Schema.String,
      }),
      {},
    );
    const getRenamed = operation({
      type: Renamed,
      resolve: () => Effect.succeed({ _tag: "renamed" as const, id: "1" }),
    });
    const registry = buildRegistry({ getRenamed });
    const renamed = Array.from(registry.nodes.values()).find((n) => n.identifier === "Renamed")!;
    expect(renamed.sentinels).toEqual([{ key: "_tag", literal: "renamed" }]);
  });

  it("does not discover nodes reachable only through operation args", () => {
    const getUser = operation({
      type: Schema.Struct({ ok: Schema.Boolean }),
      // Type-side widening of node() makes this struct fail Decoder inference;
      // only the AST matters for this discovery test.
      args: Schema.Struct({ user: User }) as never,
      resolve: () => Effect.succeed({ ok: true }),
    });
    const registry = buildRegistry({ getUser });
    expect(Array.from(registry.nodes.values()).map((n) => n.identifier)).toEqual([]);
  });

  it("identity field form throws on nullish and non-primitive key values", () => {
    const registry = buildRegistry({ getFeed });
    const user = Array.from(registry.nodes.values()).find((n) => n.identifier === "User")!;
    expect(() => user.identity!.extract({})).toThrow(/identity field "id"/);
    expect(() => user.identity!.extract({ id: { nested: true } })).toThrow(/got object/);
    expect(user.identity!.extract({ id: 42 })).toBe("42");
  });

  it("records operations with args and stream flags", () => {
    const registry = buildRegistry({ getFeed });
    expect(registry.operations).toHaveLength(1);
    const op = registry.operations[0]!;
    expect(op.name).toBe("getFeed");
    expect(op.stream).toBe(false);
    expect(op.argsAst).not.toBeNull();
    expect(registry.lookup(op.returnAst)?.identifier).toBe("Feed");
  });
});
