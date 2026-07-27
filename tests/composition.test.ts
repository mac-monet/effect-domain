import { Context, Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation } from "../src/index.ts";

class Greeter extends Context.Service<Greeter, { greet: (n: string) => string }>()("Greeter") {}

const GreeterLive = Layer.succeed(Greeter)({ greet: (n: string) => `Hello, ${n}!` });

const User = node("User", Schema.Struct({ id: Schema.String, name: Schema.String }), (f) => ({
  greeting: f.field({
    type: Schema.String,
    resolve: ({ parent }) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        return greeter.greet(parent.name);
      }),
  }),
}));

describe("Unit 8: provide(layer)", () => {
  it("narrows R when the layer satisfies the requirement", async () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
      }),
    });

    const provided = g.provide(GreeterLive);

    const exec = provided.execute("getUser", { select: { id: true, greeting: true } });

    const result = await Effect.runPromise(exec);
    expect(Result.getOrThrow(result.greeting)).toBe("Hello, Alice!");
  });

  it("returns a new domain each provide() call (immutable)", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
      }),
    });

    const a = g.provide(GreeterLive);
    const b = g.provide(GreeterLive);
    expect(a).not.toBe(b);
    expect(a).not.toBe(g);
  });

  it("preserves operations across provide()", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
      }),
    });

    const provided = g.provide(GreeterLive);
    expect(Object.keys(provided.operations)).toEqual(["getUser"]);
    expect(provided.operations.getUser).toBe(g.operations.getUser);
  });
});

class Stamper extends Context.Service<Stamper, { stamp: () => string }>()("Stamper") {}
const StamperLive = Layer.succeed(Stamper)({ stamp: () => "STAMPED" });

describe("Unit 8: provide() layer composition", () => {
  it("a later provide() satisfies the RIn of an earlier provide()", async () => {
    const StamperFromGreeter = Layer.effect(Stamper)(
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        return { stamp: () => greeter.greet("STAMP") };
      }),
    );

    const Item = node("Item", Schema.Struct({ id: Schema.String }), (f) => ({
      stamped: f.field({
        type: Schema.String,
        resolve: () =>
          Effect.gen(function* () {
            const stamper = yield* Stamper;
            return stamper.stamp();
          }),
      }),
    }));

    const g = Domain.make({
      getItem: operation({
        type: Item,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const provided = g.provide(StamperFromGreeter).provide(GreeterLive);
    const result = await Effect.runPromise(
      provided.execute("getItem", { select: { stamped: true } }),
    );
    expect(Result.getOrThrow(result.stamped)).toBe("Hello, STAMP!");
  });

  it("layers cover BOTH operation resolver and field resolvers", async () => {
    const Item = node("Item", Schema.Struct({ id: Schema.String }), (f) => ({
      greeting: f.field({
        type: Schema.String,
        resolve: ({ parent }) =>
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            return greeter.greet(parent.id);
          }),
      }),
    }));

    const g = Domain.make({
      getItem: operation({
        type: Item,
        resolve: () =>
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            return { id: greeter.greet("root").replace("Hello, ", "").replace("!", "") };
          }),
      }),
    }).provide(GreeterLive);

    const result = await Effect.runPromise(
      g.execute("getItem", { select: { id: true, greeting: true } }),
    );
    expect(Result.getOrThrow(result.id)).toBe("root");
    expect(Result.getOrThrow(result.greeting)).toBe("Hello, root!");
  });
});

describe("Unit 8: provide() layer lifetime", () => {
  const CountedItem = node("CountedItem", Schema.Struct({ id: Schema.String }), (f) => ({
    greeting: f.field({
      type: Schema.String,
      resolve: ({ parent }) =>
        Effect.gen(function* () {
          const greeter = yield* Greeter;
          return greeter.greet(parent.id);
        }),
    }),
  }));

  function makeCountedGraph() {
    let builds = 0;
    const CountingGreeter = Layer.effect(Greeter)(
      Effect.sync(() => {
        builds += 1;
        return { greet: (n: string) => `Hello, ${n}!` };
      }),
    );
    const domain = Domain.make({
      getItem: operation({
        type: CountedItem,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    return { domain, CountingGreeter, builds: () => builds };
  }

  it("constructs provided layers per execute call, even within one fiber tree", async () => {
    const { domain, CountingGreeter, builds } = makeCountedGraph();
    const provided = domain.provide(CountingGreeter);

    // Both calls run inside a single Effect.runPromise: the per-call
    // construction comes from applyLayers, not from run-boundary isolation.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* provided.execute("getItem", { select: { greeting: true } });
        yield* provided.execute("getItem", { select: { greeting: true } });
      }),
    );

    expect(builds()).toBe(2);
  });

  it("reuses services across calls with the documented build-once pattern", async () => {
    const { domain, CountingGreeter, builds } = makeCountedGraph();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(CountingGreeter);
          const provided = domain.provide(Layer.succeedContext(context));
          yield* provided.execute("getItem", { select: { greeting: true } });
          yield* provided.execute("getItem", { select: { greeting: true } });
        }),
      ),
    );

    expect(builds()).toBe(1);
  });
});

describe("Unit 8: merge via spread", () => {
  it("compose-then-provide is the correct workflow for layered subgraphs", async () => {
    const Item = node("Item", Schema.Struct({ id: Schema.String, name: Schema.String }), (f) => ({
      greeting: f.field({
        type: Schema.String,
        resolve: ({ parent }) =>
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            return greeter.greet(parent.name);
          }),
      }),
    }));
    const Counter = node("Counter", Schema.Struct({ count: Schema.Number }), (f) => ({
      stamped: f.field({
        type: Schema.String,
        resolve: ({ parent }) =>
          Effect.gen(function* () {
            const stamper = yield* Stamper;
            return `${stamper.stamp()}/${parent.count}`;
          }),
      }),
    }));

    const a = Domain.make({
      getItem: operation({
        type: Item,
        resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
      }),
    });
    const b = Domain.make({
      getCount: operation({
        type: Counter,
        resolve: () => Effect.succeed({ count: 7 }),
      }),
    });

    const merged = Domain.make({ ...a.operations, ...b.operations }).provide(
      Layer.mergeAll(GreeterLive, StamperLive),
    );

    const item = await Effect.runPromise(merged.execute("getItem", { select: { greeting: true } }));
    expect(Result.getOrThrow(item.greeting)).toBe("Hello, Alice!");

    const counter = await Effect.runPromise(
      merged.execute("getCount", { select: { stamped: true } }),
    );
    expect(Result.getOrThrow(counter.stamped)).toBe("STAMPED/7");
  });
});

describe("Unit 8: merge via spread (basic)", () => {
  it("combines two graphs by spreading operations", async () => {
    const ItemNode = node("Item", Schema.Struct({ id: Schema.String, name: Schema.String }), {});
    const Counter = node("Counter", Schema.Struct({ count: Schema.Number }), {});

    const a = Domain.make({
      getItem: operation({
        type: ItemNode,
        resolve: () => Effect.succeed({ id: "1", name: "A" }),
      }),
    });

    const b = Domain.make({
      getCount: operation({
        type: Counter,
        resolve: () => Effect.succeed({ count: 42 }),
      }),
    });

    const merged = Domain.make({ ...a.operations, ...b.operations });
    expect(Object.keys(merged.operations).sort()).toEqual(["getCount", "getItem"]);

    const item = await Effect.runPromise(
      merged.execute("getItem", { select: { id: true, name: true } }),
    );
    expect(Result.getOrThrow(item.id)).toBe("1");
    expect(Result.getOrThrow(item.name)).toBe("A");

    const counter = await Effect.runPromise(
      merged.execute("getCount", { select: { count: true } }),
    );
    expect(Result.getOrThrow(counter.count)).toBe(42);
  });
});
