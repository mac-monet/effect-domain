import { Effect, Result, Schema } from "effect";
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

    const authors = Result.getOrThrow(result.authors) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(authors).toHaveLength(3);
    expect(batchCallCount).toBe(1);
    expect(receivedKeys).toHaveLength(3);
    expect(receivedKeys).toContain("a1");
    expect(receivedKeys).toContain("a2");
    expect(receivedKeys).toContain("a3");

    const posts0 = Result.getOrThrow(authors[0].posts) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(posts0).toHaveLength(1);
    expect(Result.getOrThrow(posts0[0].title)).toBe("Post by a1");
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

    const items = Result.getOrThrow(result.items) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(Result.getOrThrow(items[0].detail)).toBe("detail-for-x");
    expect(Result.getOrThrow(items[1].detail)).toBe("detail-for-y");
    expect(Result.getOrThrow(items[2].detail)).toBe("detail-for-z");
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

    const items = Result.getOrThrow(result.items) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(Result.getOrThrow(items[0].upper)).toBe("ALICE");
    expect(Result.getOrThrow(items[0].related)).toBe("related-1");
    expect(Result.getOrThrow(items[1].upper)).toBe("BOB");
    expect(Result.getOrThrow(items[1].related)).toBe("related-2");
    expect(batchCalled).toBe(true);
  });

  it("per-key failure produces Result.Failure for that parent, siblings succeed", async () => {
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

    const result = await Effect.runPromise(
      g.execute("getItems", {
        select: { items: { select: { id: true, value: true } } },
      }),
    );

    const items = Result.getOrThrow(result.items) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(Result.isSuccess(items[0].value)).toBe(true);
    expect(Result.getOrThrow(items[0].value)).toBe("value-good");
    expect(Result.isFailure(items[1].value)).toBe(true);
    expect(Result.isSuccess(items[2].value)).toBe(true);
    expect(Result.getOrThrow(items[2].value)).toBe("value-also-good");
  });

  it("batch-level failure fails all parents using that field", async () => {
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

    const result = await Effect.runPromise(
      g.execute("getItems", {
        select: { items: { select: { id: true, value: true } } },
      }),
    );

    const items = Result.getOrThrow(result.items) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(Result.isSuccess(items[0].id)).toBe(true);
    expect(Result.isFailure(items[0].value)).toBe(true);
    expect(Result.isSuccess(items[1].id)).toBe(true);
    expect(Result.isFailure(items[1].value)).toBe(true);
  });

  it("property: duplicate keys and missing map entries route per parent", async () => {
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

          const result = await Effect.runPromise(
            g.execute("getItems", {
              select: { items: { select: { id: true, value: true } } },
            }),
          );
          const items = Result.getOrThrow(result.items) as Array<
            Record<string, Result.Result<unknown, unknown>>
          >;

          expect(receivedKeys).toEqual(ids);
          expect(items).toHaveLength(ids.length);
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i]!;
            expect(Result.getOrThrow(items[i]!.id)).toBe(id);
            if (missing.has(id)) {
              expect(Result.isFailure(items[i]!.value)).toBe(true);
            } else {
              expect(Result.getOrThrow(items[i]!.value)).toBe(`value-${id}`);
            }
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
