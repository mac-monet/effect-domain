import { Effect, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { domain, makeReposLive, type BatchingStats } from "../examples/batching.ts";

describe("Examples: Effect request batching for N+1", () => {
  it("loads selected relation-like fields in one batched resolver call", async () => {
    const stats: BatchingStats = { postBatchCalls: 0, lastAuthorIds: [] };

    const result = await Effect.runPromise(
      domain
        .execute("listUsers", {
          select: {
            id: true,
            posts: { select: { title: true } },
          },
        })
        .pipe(Effect.provide(makeReposLive(stats))),
    );

    expect(stats.postBatchCalls).toBe(1);
    expect(stats.lastAuthorIds).toEqual(["u1", "u2", "u3"]);

    const firstPosts = Result.getOrThrow(result[0]!.posts);
    expect(Result.getOrThrow(firstPosts[0]!.title)).toBe("Post by Alice");
  });
});
