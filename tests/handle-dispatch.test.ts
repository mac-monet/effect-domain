import { Effect, Exit, Layer, Option, Result, Schema, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { domain, UserNotFound, UserRepo, UserRepoLive } from "../examples/domain.ts";
import { Domain, operation, OperationError, UnknownOperation } from "../src/index.ts";

const liveDomain = domain.provide(UserRepoLive);

// handleDispatch/handleSubscription produce the encoded wire envelope; the
// matching decoder is the domain's own dispatchResultSchemaDynamic.
const decode = (name: string, select?: unknown) =>
  Schema.decodeUnknownSync(domain.dispatchResultSchemaDynamic(name, select as never));

describe("handleDispatch", () => {
  it("encodes a success into the wire envelope and round-trips it", async () => {
    const select = { id: true, fullName: true };
    const encoded = await Effect.runPromise(
      liveDomain.handleDispatch({ name: "getUser", args: { id: "1" }, select }),
    );
    expect(encoded).toMatchObject({ _tag: "Success" });

    const decoded = decode("getUser", select)(encoded);
    expect(Result.isSuccess(decoded)).toBe(true);
    const user = (decoded as Result.Success<Record<string, string>, never>).success;
    expect(user.id).toBe("1");
    expect(user.fullName).toBe("Alice Anderson");
  });

  it("encodes a declared operation error that decodes to a live instance", async () => {
    const select = { id: true };
    const encoded = await Effect.runPromise(
      liveDomain.handleDispatch({ name: "getUser", args: { id: "missing" }, select }),
    );
    expect(encoded).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OperationError", cause: { _tag: "UserNotFound", id: "missing" } },
    });

    const decoded = decode("getUser", select)(encoded);
    const failure = (decoded as Result.Failure<unknown, OperationError<unknown>>).failure;
    expect(failure).toBeInstanceOf(OperationError);
    expect(failure.cause).toBeInstanceOf(UserNotFound);
  });

  it("encodes gateway failures for unknown names and bad args", async () => {
    const unknown = await Effect.runPromise(liveDomain.handleDispatch({ name: "nope" }));
    expect(unknown).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownOperation" } });
    const decodedUnknown = decode("nope")(unknown);
    expect((decodedUnknown as Result.Failure<unknown, unknown>).failure).toBeInstanceOf(
      UnknownOperation,
    );

    const badArgs = await Effect.runPromise(
      liveDomain.handleDispatch({ name: "getUser", args: { id: 1 }, select: { id: true } }),
    );
    expect(badArgs).toMatchObject({ _tag: "Failure", failure: { _tag: "ArgsParseError" } });
  });
});

describe("handleDispatch compile-time gates", () => {
  it("rejects reads options and undeclared error schemas", () => {
    const request = { name: "getUser", args: { id: "1" }, select: { id: true } };
    // @ts-expect-error reads reshapes the success value and cannot round-trip the wire codec
    const withReads = liveDomain.handleDispatch(request, { reads: true });

    class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", { message: Schema.String }) {}
    const incomplete = Domain.make({
      explode: operation({
        type: Schema.String,
        resolve: () => Effect.fail(new Boom({ message: "x" })) as Effect.Effect<string, Boom>,
      }),
    });
    // @ts-expect-error explode fails with Boom but declares no error schema
    const unserializable = incomplete.handleDispatch({ name: "explode" });

    expect(withReads).toBeDefined();
    expect(unserializable).toBeDefined();
  });
});

describe("ProvidedE in dispatch-family error channels", () => {
  it("types layer acquisition failures instead of claiming never", () => {
    class LayerBoom extends Schema.TaggedErrorClass<LayerBoom>()("LayerBoom", {}) {}
    const failing = domain.provide(
      Layer.effect(UserRepo)(Effect.fail(new LayerBoom()) as Effect.Effect<never, LayerBoom>),
    );
    expectTypeOf(failing.dispatch({ name: "getUser" })).toExtend<
      Effect.Effect<unknown, LayerBoom, never>
    >();
    expectTypeOf(failing.handleDispatch({ name: "getUser" })).toExtend<
      Effect.Effect<unknown, LayerBoom, never>
    >();
    expectTypeOf(failing.handleSubscription({ name: "watchUsers" })).toExtend<
      Stream.Stream<unknown, LayerBoom, never>
    >();
    // The infallible-layer domain keeps never.
    expectTypeOf(liveDomain.handleDispatch({ name: "getUser" })).toExtend<
      Effect.Effect<unknown, never, never>
    >();
  });

  it("propagates the layer failure at runtime through handleDispatch", async () => {
    class LayerBoom extends Schema.TaggedErrorClass<LayerBoom>()("LayerBoom", {}) {}
    const failing = domain.provide(
      Layer.effect(UserRepo)(Effect.fail(new LayerBoom()) as Effect.Effect<never, LayerBoom>),
    );
    const exit = await Effect.runPromiseExit(
      failing.handleDispatch({ name: "getUser", args: { id: "1" }, select: { id: true } }),
    );
    expect(Exit.findErrorOption(exit).pipe(Option.getOrThrow)).toBeInstanceOf(LayerBoom);
  });
});

describe("handleSubscription", () => {
  it("encodes each stream item as a one-shot dispatch envelope", async () => {
    const select = { id: true, fullName: true };
    const items = await Effect.runPromise(
      Stream.runCollect(
        liveDomain.handleSubscription({ name: "watchUsers", args: { start: 10 }, select }),
      ),
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      const decoded = decode("watchUsers", select)(item);
      expect(Result.isSuccess(decoded)).toBe(true);
    }
  });

  it("emits a single encoded gateway failure for boundary errors", async () => {
    const items = await Effect.runPromise(
      Stream.runCollect(liveDomain.handleSubscription({ name: "getUser", args: { id: "1" } })),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ _tag: "Failure", failure: { _tag: "WrongOperationKind" } });
  });
});

// One-arg client: transport is handleDispatch/handleSubscription on the
// same instance — the two ends of the wire with nothing in between. If this
// round-trips, any transport that faithfully moves the envelope round-trips
// too.
describe("client over handleDispatch (in-process wire)", () => {
  const client = Domain.client(liveDomain);

  it("types nested projections as plain data trees (regression: Omit broke const-S inference)", () => {
    const eff = client.execute("getUser", {
      args: { id: "1" },
      select: { id: true, profile: { select: { location: true } } },
    });
    type Success = Effect.Success<typeof eff>;
    expectTypeOf<Success["id"]>().toExtend<string>();
    expectTypeOf<Success["profile"]>().toExtend<{ readonly location: string }>();
  });

  it("round-trips a typed success", async () => {
    const user = await Effect.runPromise(
      client.execute("getUser", { args: { id: "1" }, select: { id: true, fullName: true } }),
    );
    expect(user.id).toBe("1");
    expect(user.fullName).toBe("Alice Anderson");
  });

  it("unwraps a declared error into the typed error channel", async () => {
    const exit = await Effect.runPromiseExit(
      client.execute("getUser", { args: { id: "missing" }, select: { id: true } }),
    );
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);
    expect(error).toBeInstanceOf(UserNotFound);
  });

  it("streams subscription items as decoded results", async () => {
    const items = await Effect.runPromise(
      Stream.runCollect(
        client.subscribe("watchUsers", { args: { start: 5 }, select: { id: true } }),
      ),
    );
    expect(items.map((row) => row.id)).toEqual(["5", "6"]);
  });
});
