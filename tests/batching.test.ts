import { Cause, Effect, Exit, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

describe("Unit 5: batched fields via key", () => {
  it("batched field called once with all keys, not N times", async () => {
    let batchCallCount = 0;
    let receivedKeys: Array<string> = [];

    const Author = node(
      "Author",
      Schema.Struct({ id: Schema.String, name: Schema.String }),
      (f) => ({
        posts: f.field({
          type: Schema.Array(Schema.Struct({ title: Schema.String })),
          key: (parent) => parent.id,
          resolve: (keys: ReadonlyArray<string>) => {
            batchCallCount++;
            receivedKeys = [...keys];
            const results = new Map<string, Array<{ title: string }>>();
            for (const key of keys) {
              results.set(key, [{ title: `Post by ${key}` }]);
            }
            return Effect.succeed(results);
          },
        }),
      }),
    );

    const Container = node("AuthorContainer", Schema.Struct({ id: Schema.String }), {
      authors: field({
        type: Schema.Array(Author),
        resolve: () =>
          Effect.succeed([
            { id: "a1", name: "Alice" },
            { id: "a2", name: "Bob" },
            { id: "a3", name: "Carol" },
          ]),
      }),
    });

    const g = Domain.make({
      getAuthors: operation({
        type: Container,
        resolve: () => Effect.succeed({ id: "root" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getAuthors", {
        select: {
          authors: {
            select: { id: true, posts: { select: { title: true } } },
          },
        },
      }),
    );

    const authors = result.authors as Array<Record<string, unknown>>;
    expect(authors).toHaveLength(3);
    expect(batchCallCount).toBe(1);
    expect(receivedKeys).toHaveLength(3);
    expect(receivedKeys).toContain("a1");
    expect(receivedKeys).toContain("a2");
    expect(receivedKeys).toContain("a3");

    expect(authors[0]!.posts).toEqual([{ title: "Post by a1" }]);
  });

  it("results mapped back to correct parents", async () => {
    const Item = node("BatchItem", Schema.Struct({ id: Schema.String }), (f) => ({
      detail: f.field({
        type: Schema.String,
        key: (parent) => parent.id,
        resolve: (keys: ReadonlyArray<string>) => {
          const results = new Map<string, string>();
          for (const key of keys) {
            results.set(key, `detail-for-${key}`);
          }
          return Effect.succeed(results);
        },
      }),
    }));

    const Container = node("ItemContainer", Schema.Struct({ id: Schema.String }), {
      items: field({
        type: Schema.Array(Item),
        resolve: () => Effect.succeed([{ id: "x" }, { id: "y" }, { id: "z" }]),
      }),
    });

    const g = Domain.make({
      getItems: operation({
        type: Container,
        resolve: () => Effect.succeed({ id: "root" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getItems", {
        select: { items: { select: { id: true, detail: true } } },
      }),
    );

    expect(result.items).toEqual([
      { id: "x", detail: "detail-for-x" },
      { id: "y", detail: "detail-for-y" },
      { id: "z", detail: "detail-for-z" },
    ]);
  });

  it("FieldFactory callback works for both field modes", async () => {
    let batchCalled = false;

    const Mixed = node(
      "MixedFields",
      Schema.Struct({ id: Schema.String, name: Schema.String }),
      (f) => ({
        upper: f.field({
          type: Schema.String,
          resolve: ({ parent }) => Effect.succeed(parent.name.toUpperCase()),
        }),
        related: f.field({
          type: Schema.String,
          key: (parent) => parent.id,
          resolve: (keys: ReadonlyArray<string>) => {
            batchCalled = true;
            const results = new Map<string, string>();
            for (const key of keys) {
              results.set(key, `related-${key}`);
            }
            return Effect.succeed(results);
          },
        }),
      }),
    );

    const Container = node("MixedContainer", Schema.Struct({ id: Schema.String }), {
      items: field({
        type: Schema.Array(Mixed),
        resolve: () =>
          Effect.succeed([
            { id: "1", name: "alice" },
            { id: "2", name: "bob" },
          ]),
      }),
    });

    const g = Domain.make({
      getItems: operation({
        type: Container,
        resolve: () => Effect.succeed({ id: "root" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getItems", {
        select: { items: { select: { id: true, upper: true, related: true } } },
      }),
    );

    expect(result.items).toEqual([
      { id: "1", upper: "ALICE", related: "related-1" },
      { id: "2", upper: "BOB", related: "related-2" },
    ]);
    expect(batchCalled).toBe(true);
  });

  it("missing map entry for a key fails the operation with NoSuchElementError", async () => {
    const Item = node("FailItem", Schema.Struct({ id: Schema.String }), (f) => ({
      value: f.field({
        type: Schema.String,
        key: (parent) => parent.id,
        resolve: (keys: ReadonlyArray<string>) => {
          const results = new Map<string, string>();
          for (const key of keys) {
            if (key !== "bad") {
              results.set(key, `value-${key}`);
            }
          }
          return Effect.succeed(results);
        },
      }),
    }));

    const Container = node("FailContainer", Schema.Struct({ id: Schema.String }), {
      items: field({
        type: Schema.Array(Item),
        resolve: () => Effect.succeed([{ id: "good" }, { id: "bad" }, { id: "also-good" }]),
      }),
    });

    const g = Domain.make({
      getItems: operation({
        type: Container,
        resolve: () => Effect.succeed({ id: "root" }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      g.execute("getItems", {
        select: { items: { select: { id: true, value: true } } },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(Cause.isNoSuchElementError(failure.value)).toBe(true);
      }
    }
  });

  it("batch-level failure fails the operation with the batch error", async () => {
    const Item = node("BatchFailItem", Schema.Struct({ id: Schema.String }), (f) => ({
      value: f.field({
        type: Schema.String,
        key: (parent) => parent.id,
        resolve: (_keys: ReadonlyArray<string>) => Effect.fail("db-down" as const),
      }),
    }));

    const Container = node("BatchFailContainer", Schema.Struct({ id: Schema.String }), {
      items: field({
        type: Schema.Array(Item),
        resolve: () => Effect.succeed([{ id: "a" }, { id: "b" }]),
      }),
    });

    const g = Domain.make({
      getItems: operation({
        type: Container,
        resolve: () => Effect.succeed({ id: "root" }),
      }),
    });

    const error = await Effect.runPromise(
      Effect.flip(
        g.execute("getItems", {
          select: { items: { select: { id: true, value: true } } },
        }),
      ),
    );

    expect(error).toBe("db-down");
  });

  it("property: duplicate keys batch once; any missing entry fails the operation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 8 }),
        fc.subarray(["a", "b", "c", "d"] as const),
        async (ids, missingIds) => {
          const missing = new Set<string>(missingIds);
          let receivedKeys: ReadonlyArray<string> = [];

          const Item = node("FuzzBatchItem", Schema.Struct({ id: Schema.String }), (f) => ({
            value: f.field({
              type: Schema.String,
              key: (parent) => parent.id,
              resolve: (keys: ReadonlyArray<string>) => {
                receivedKeys = keys;
                const results = new Map<string, string>();
                for (const key of keys) {
                  if (!missing.has(key)) {
                    results.set(key, `value-${key}`);
                  }
                }
                return Effect.succeed(results);
              },
            }),
          }));

          const Container = node("FuzzBatchContainer", Schema.Struct({ id: Schema.String }), {
            items: field({
              type: Schema.Array(Item),
              resolve: () => Effect.succeed(ids.map((id) => ({ id }))),
            }),
          });

          const g = Domain.make({
            getItems: operation({
              type: Container,
              resolve: () => Effect.succeed({ id: "root" }),
            }),
          });

          const exit = await Effect.runPromiseExit(
            g.execute("getItems", {
              select: { items: { select: { id: true, value: true } } },
            }),
          );

          expect(receivedKeys).toEqual(ids);

          const anyMissing = ids.some((id) => missing.has(id));
          if (anyMissing) {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const failure = Cause.findErrorOption(exit.cause);
              expect(failure._tag === "Some" && Cause.isNoSuchElementError(failure.value)).toBe(
                true,
              );
            }
          } else {
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) {
              const items = exit.value.items as Array<Record<string, unknown>>;
              expect(items).toEqual(ids.map((id) => ({ id, value: `value-${id}` })));
            }
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
