import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation, type ReadSet } from "../src/index.ts";

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
        Effect.succeed(new Map(keys.map((k) => [k, { id: k, name: `user-${k}` } as never]))),
    }),
  }),
  { identity: "id" },
);

const Tag = node(
  "Tag",
  // No identity declared — must not appear in read sets.
  Schema.Struct({ label: Schema.String }),
  {},
);

const Feed = node(
  "Feed",
  Schema.Struct({
    id: Schema.String,
    posts: Schema.Array(Post),
    tags: Schema.Array(Tag),
  }),
  {},
  { identity: (feed) => `feed:${feed.id}` },
);

const domain = Domain.make({
  getFeed: operation({
    type: Feed,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.succeed({
        id: args.id,
        posts: [
          { id: "p1", title: "One", authorId: "a" },
          { id: "p2", title: "Two", authorId: "a" },
        ],
        tags: [{ label: "x" }],
      }),
  }),
});

function keys(reads: ReadSet): ReadonlyArray<string> {
  return reads.map((r) => `${r.node}:${r.key}`).sort((a, b) => a.localeCompare(b));
}

describe("execute with reads: true", () => {
  it("collects the identified entities the walk touched", async () => {
    const { reads, result } = await Effect.runPromise(
      domain.execute("getFeed", {
        args: { id: "f1" },
        reads: true,
        select: {
          id: true,
          posts: { select: { title: true, author: { select: { name: true } } } },
        },
      }),
    );
    expect(Result.getOrThrow(result.id)).toBe("f1");
    expect(keys(reads)).toEqual(["Feed:feed:f1", "Post:p1", "Post:p2", "User:a"]);
  });

  it("dedupes repeated entities and skips nodes without identity", async () => {
    const { reads } = await Effect.runPromise(
      domain.execute("getFeed", {
        args: { id: "f1" },
        reads: true,
        select: {
          posts: { select: { author: { select: { id: true } } } },
          tags: { select: { label: true } },
        },
      }),
    );
    const users = reads.filter((r) => r.node === "User");
    expect(users).toHaveLength(1); // both posts share author "a"
    expect(reads.some((r) => r.node === "Tag")).toBe(false);
  });

  it("only records entities the selection actually walks", async () => {
    const { reads } = await Effect.runPromise(
      domain.execute("getFeed", {
        args: { id: "f1" },
        reads: true,
        select: { id: true },
      }),
    );
    // Root only — posts/authors were never resolved.
    expect(keys(reads)).toEqual(["Feed:feed:f1"]);
  });

  it("returns a fresh read set per execution of the same effect", async () => {
    const effect = domain.execute("getFeed", {
      args: { id: "f1" },
      reads: true,
      select: { id: true },
    });
    const first = await Effect.runPromise(effect);
    const second = await Effect.runPromise(effect);
    expect(first.reads).toEqual(second.reads);
    expect(first.reads).not.toBe(second.reads);
  });

  it("plain execute is unaffected", async () => {
    const result = await Effect.runPromise(
      domain.execute("getFeed", { args: { id: "f1" }, select: { id: true } }),
    );
    expect(result).not.toHaveProperty("reads");
    expect(Result.getOrThrow(result.id)).toBe("f1");
  });
});
