import { Cause, Context, Effect, Exit, Layer, Schema } from "effect";
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

  it("missing map entry for a key dies as a resolver contract violation", async () => {
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
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
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

          // The resolver sees each key once, in first-appearance order.
          expect(receivedKeys).toEqual([...new Set(ids)]);

          const anyMissing = ids.some((id) => missing.has(id));
          if (anyMissing) {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.hasDies(exit.cause)).toBe(true);
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

describe("shared resolve functions coalesce; runs stay isolated", () => {
  it("two fields sharing one resolve fn share one request family", async () => {
    let calls = 0;
    let received: ReadonlyArray<string> = [];
    const sharedResolve = (keys: ReadonlyArray<string>) =>
      Effect.sync(() => {
        calls++;
        received = keys;
        return new Map(keys.map((k) => [k, `v-${k}`]));
      });
    const Left = node("ShareLeft", Schema.Struct({ aId: Schema.String }), (f) => ({
      a: f.field({ type: Schema.String, key: (p) => p.aId, resolve: sharedResolve }),
    }));
    const Right = node("ShareRight", Schema.Struct({ bId: Schema.String }), (f) => ({
      b: f.field({ type: Schema.String, key: (p) => p.bId, resolve: sharedResolve }),
    }));
    const Root = node("ShareRoot", Schema.Struct({ left: Left, right: Right }), {});
    const g = Domain.make({
      get: operation({
        type: Root,
        resolve: () => Effect.succeed({ left: { aId: "x" }, right: { bId: "y" } }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("get", {
        select: { left: { select: { a: true } }, right: { select: { b: true } } },
      }),
    );
    expect(result).toEqual({ left: { a: "v-x" }, right: { b: "v-y" } });
    expect(calls).toBe(1);
    expect([...received].sort()).toEqual(["x", "y"]);
  });

  it("concurrent runs with different provided services never share a batch", async () => {
    class Tenant extends Context.Service<Tenant, { readonly name: string }>()(
      "BatchIsolationTenant",
    ) {}
    const seen: Array<{ tenant: string; keys: ReadonlyArray<string> }> = [];
    const sharedResolve = (keys: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const tenant = yield* Tenant;
        // Yield so concurrent runs' batching windows would overlap if
        // coalescing crossed run boundaries.
        yield* Effect.sleep(10);
        seen.push({ tenant: tenant.name, keys });
        return new Map(keys.map((k) => [k, `${tenant.name}:${k}`]));
      });
    const Item = node("IsolationItem", Schema.Struct({ id: Schema.String }), (f) => ({
      value: f.field({ type: Schema.String, key: (p) => p.id, resolve: sharedResolve }),
    }));
    const make = (name: string) =>
      Domain.make({
        get: operation({
          type: Item,
          args: Schema.Struct({ id: Schema.String }),
          resolve: ({ args }) => Effect.succeed({ id: args.id }),
        }),
      }).provide(Layer.succeed(Tenant, { name }));

    const [a, b] = await Promise.all([
      Effect.runPromise(make("A").execute("get", { args: { id: "k1" }, select: { value: true } })),
      Effect.runPromise(make("B").execute("get", { args: { id: "k1" }, select: { value: true } })),
    ]);

    expect(a.value).toBe("A:k1");
    expect(b.value).toBe("B:k1");
    // Two separate batch calls, one per run — no cross-run coalescing, no
    // context leakage between tenants.
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.tenant).sort()).toEqual(["A", "B"]);
  });
});
