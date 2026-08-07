import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  crossEntryProgram,
  domain,
  makeReposLive,
  type BatchingStats,
} from "../examples/batching.ts";

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

    const firstPosts = result[0]!.posts;
    expect(firstPosts[0]!.title).toBe("Post by Alice");
  });

  it("batched fields coalesce across array-form entries", async () => {
    const stats: BatchingStats = { postBatchCalls: 0, lastAuthorIds: [] };

    const [users, user] = await Effect.runPromise(
      crossEntryProgram.pipe(Effect.provide(makeReposLive(stats))),
    );

    expect(stats.postBatchCalls).toBe(1);
    // One batched call carrying every entry's keys, deduplicated: "u1" is
    // requested by both entries but the resolver sees it once.
    expect([...stats.lastAuthorIds].sort()).toEqual(["u1", "u2", "u3"]);
    expect(users).toHaveLength(3);
    expect(user.posts[0]!.title).toBe("Post by Alice");
  });
});
