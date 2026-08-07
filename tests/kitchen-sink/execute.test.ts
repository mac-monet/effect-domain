import { Effect, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { ReadSet } from "../../src/index.ts";
import { domain, KSUserNotFound, makeLive, makeStats } from "./domain.ts";

const keys = (reads: ReadSet): ReadonlyArray<string> =>
  reads.map((r) => `${r.node}:${r.key}`).sort((a, b) => a.localeCompare(b));

describe("kitchen sink: execute", () => {
  it("walks a deep selection through the User -> Post -> User cycle", async () => {
    const stats = makeStats();
    const user = await Effect.runPromise(
      domain
        .execute("getUser", {
          args: { id: "u1" },
          select: {
            id: true,
            fullName: true,
            posts: {
              select: {
                title: true,
                author: { select: { fullName: true } },
                editor: { select: { id: true } },
                comments: { select: { body: true, author: { select: { id: true } } } },
              },
            },
          },
        })
        .pipe(Effect.provide(makeLive(stats))),
    );

    expect(user.id).toBe("u1");
    expect(user.fullName).toBe("Ada Lovelace");
    expect(user.posts).toHaveLength(2);
    const p1 = user.posts.find((p) => p.title === "Engines")!;
    expect(p1.author).toEqual({ fullName: "Ada Lovelace" });
    expect(p1.editor).toEqual({ id: "u2" });
    expect(p1.comments).toEqual([
      { body: "Nice", author: { id: "u2" } },
      { body: "Agreed", author: { id: "u3" } },
    ]);
    const p3 = user.posts.find((p) => p.title === "Machines")!;
    expect(p3.editor).toBeNull();

    // posts batched once. post.author (p1, p3 → u1, twice) and comment.author
    // (c1 → u2, c2 → u3) share the batchUsers function, so they share one
    // request family: one batch call with distinct keys, not per-field calls
    // and not per-row (which would be 4).
    expect(stats.postBatchCalls).toBe(1);
    expect(stats.userBatchCalls).toBe(1);
    expect([...stats.lastUserKeys].sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("array form returns a tuple and coalesces batched fields across entries", async () => {
    const stats = makeStats();
    const [a, b, count] = await Effect.runPromise(
      domain
        .execute([
          {
            name: "getUser",
            args: { id: "u1" },
            select: { id: true, posts: { select: { title: true } } },
          },
          {
            name: "getUser",
            args: { id: "u2" },
            select: { posts: { select: { title: true } } },
          },
          { name: "countUsers" },
        ])
        .pipe(Effect.provide(makeLive(stats))),
    );

    expect(a.id).toBe("u1");
    expect(a.posts.map((p) => p.title).sort()).toEqual(["Engines", "Machines"]);
    expect(b.posts.map((p) => p.title)).toEqual(["Compilers"]);
    expect(count).toBe(3);

    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf(a.id).toEqualTypeOf<string>();

    // Both entries' posts selections landed in one findByAuthorIds call.
    expect(stats.postBatchCalls).toBe(1);
    expect([...stats.lastPostKeys].sort()).toEqual(["u1", "u2"]);
  });

  it("reads: true dedupes entities, uses the derived Feed key, and skips KSTag", async () => {
    const { reads, result } = await Effect.runPromise(
      domain
        .execute("getFeed", {
          args: { id: "f1" },
          reads: true,
          select: {
            id: true,
            posts: {
              select: {
                title: true,
                tags: { select: { label: true } },
                author: { select: { id: true } },
                comments: { select: { author: { select: { id: true } } } },
              },
            },
          },
        })
        .pipe(Effect.provide(makeLive())),
    );

    expect(result.id).toBe("f1");
    expect(keys(reads)).toEqual([
      "KSComment:c1",
      "KSComment:c2",
      "KSComment:c3",
      "KSFeed:feed:f1",
      "KSPost:p1",
      "KSPost:p2",
      "KSPost:p3",
      // u1 appears as post author and comment author — deduped to one entry.
      "KSUser:u1",
      "KSUser:u2",
      "KSUser:u3",
    ]);
    expect(reads.some((r) => r.node === "KSTag")).toBe(false);
  });

  it("array form fails fast with the entry's declared error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        domain
          .execute([
            { name: "getUser", args: { id: "missing" }, select: { id: true } },
            { name: "countUsers" },
          ])
          .pipe(Effect.provide(makeLive())),
      ),
    );
    expect(error).toBeInstanceOf(KSUserNotFound);
  });

  it("subscribes with a projected selection over streamed posts", async () => {
    const items = await Effect.runPromise(
      Stream.runCollect(
        domain.subscribe("watchPosts", {
          args: { authorId: "u1" },
          select: { title: true, author: { select: { fullName: true } } },
        }),
      ).pipe(Effect.provide(makeLive())),
    );
    expect(Array.from(items)).toEqual([
      { title: "Engines", author: { fullName: "Ada Lovelace" } },
      { title: "Machines", author: { fullName: "Ada Lovelace" } },
    ]);
  });

  it("createPost mutates repo state visible to later operations", async () => {
    const layer = makeLive();
    const program = Effect.gen(function* () {
      const created = yield* domain.execute("createPost", {
        args: { title: "Fresh", authorId: "u3" },
        select: { id: true, title: true },
      });
      const author = yield* domain.execute("getUser", {
        args: { id: "u3" },
        select: { posts: { select: { title: true } } },
      });
      return { created, author };
    });
    const { created, author } = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(created.title).toBe("Fresh");
    expect(author.posts.map((p) => p.title)).toEqual(["Fresh"]);
  });
});
