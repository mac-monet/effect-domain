import { Effect, Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { domain, UserNotFound, UserRepoLive } from "../examples/domain.ts";
import { Domain, operation, OperationError, UnknownOperation } from "../src/index.ts";

const liveDomain = domain.provide(UserRepoLive);

describe("errorSchema", () => {
  it("returns the declared schema and round-trips a live error", () => {
    const schema = domain.errorSchema("getUser");
    const original = new UserNotFound({ id: "42", message: "User 42 not found" });
    const wire = Schema.encodeUnknownSync(schema)(original);
    const decoded = Schema.decodeUnknownSync(schema)(wire);
    expect(decoded).toBeInstanceOf(UserNotFound);
    expect(decoded).toMatchObject({ _tag: "UserNotFound", id: "42" });
  });

  it("falls back to Schema.Never for operations without a declared error", () => {
    const schema = domain.errorSchema("listUsers");
    expect(() => Schema.decodeUnknownSync(schema)({ anything: true })).toThrow();
  });

  it("throws synchronously on unknown operation names", () => {
    expect(() => domain.errorSchema("nope" as never)).toThrow(/Unknown operation/);
  });

  it("types the codec against the resolver's failure type", () => {
    expectTypeOf(domain.errorSchema("getUser")["Type"]).toEqualTypeOf<UserNotFound>();
    expectTypeOf(domain.errorSchema("listUsers")["Type"]).toEqualTypeOf<never>();
  });
});

describe("dispatchResultSchema with declared error default", () => {
  const select = { id: true } as const;

  it("round-trips an OperationError using the declared schema", async () => {
    const result = await Effect.runPromise(
      liveDomain.dispatch({ name: "getUser", args: { id: "missing" }, select }),
    );
    expect(Result.isFailure(result)).toBe(true);

    const codec = domain.dispatchResultSchema("getUser", select);
    const wire = Schema.encodeUnknownSync(codec)(result);
    const decoded = Schema.decodeUnknownSync(codec)(wire);

    expect(Result.isFailure(decoded)).toBe(true);
    const failure = (decoded as Result.Failure<unknown, unknown>).failure;
    expect(failure).toBeInstanceOf(OperationError);
    expect((failure as OperationError<UserNotFound>).cause).toBeInstanceOf(UserNotFound);
  });

  it("round-trips a success the same as the explicit-schema form", async () => {
    const result = await Effect.runPromise(
      liveDomain.dispatch({ name: "getUser", args: { id: "1" }, select }),
    );
    const codec = domain.dispatchResultSchema("getUser", select);
    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result));
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("an explicit schema still overrides the declared one", () => {
    const codec = domain.dispatchResultSchema("getUser", select, Schema.String);
    expectTypeOf(codec["Type"]).toExtend<Result.Result<unknown, unknown>>();
    // Failure channel is typed from the override, not the declaration.
    type Failure =
      Extract<(typeof codec)["Type"], Result.Failure<any, any>> extends Result.Failure<any, infer E>
        ? E
        : never;
    expectTypeOf<Extract<Failure, OperationError<any>>>().toEqualTypeOf<OperationError<string>>();
  });

  it("types the default failure channel from the declared error", () => {
    const codec = domain.dispatchResultSchema("getUser", select);
    type Failure =
      Extract<(typeof codec)["Type"], Result.Failure<any, any>> extends Result.Failure<any, infer E>
        ? E
        : never;
    expectTypeOf<Extract<Failure, OperationError<any>>>().toEqualTypeOf<
      OperationError<UserNotFound>
    >();
  });
});

describe("dispatchResultSchemaDynamic", () => {
  it("matches the typed codec for a known operation", async () => {
    const result = await Effect.runPromise(
      liveDomain.dispatch({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
    );
    const codec = domain.dispatchResultSchemaDynamic("getUser", { id: true });
    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result));
    expect(Result.isFailure(decoded)).toBe(true);
    const failure = (decoded as Result.Failure<unknown, unknown>).failure;
    expect(failure).toBeInstanceOf(OperationError);
    expect((failure as OperationError<unknown>).cause).toBeInstanceOf(UserNotFound);
  });

  it("a failed codec build does not poison the cache (repeat calls stay consistent)", () => {
    // Same invalid selection twice: the second call must also throw (typed
    // path) / fall back (dynamic path), not return a cached unrealized
    // placeholder from the first failed build.
    const bad = { bogus: true } as never;
    expect(() => domain.responseSchema("getUser", bad)).toThrow(/unknown selection field/);
    expect(() => domain.responseSchema("getUser", bad)).toThrow(/unknown selection field/);
    for (const codec of [
      domain.dispatchResultSchemaDynamic("getUser", bad),
      domain.dispatchResultSchemaDynamic("getUser", bad),
    ]) {
      const error = new UnknownOperation({ operation: "nope" });
      const decoded = Schema.decodeUnknownSync(codec)(
        Schema.encodeUnknownSync(codec)(Result.fail(error)),
      );
      expect(Result.isFailure(decoded)).toBe(true);
    }
  });

  it("never throws: unknown names and invalid selections fall back to the gateway codec", () => {
    for (const codec of [
      domain.dispatchResultSchemaDynamic("nope", undefined),
      domain.dispatchResultSchemaDynamic("watchUsers", undefined),
      domain.dispatchResultSchemaDynamic("getUser", { bogus: true } as never),
    ]) {
      const error = new UnknownOperation({ operation: "nope" });
      const decoded = Schema.decodeUnknownSync(codec)(
        Schema.encodeUnknownSync(codec)(Result.fail(error)),
      );
      expect(Result.isFailure(decoded)).toBe(true);
      expect((decoded as Result.Failure<unknown, unknown>).failure).toBeInstanceOf(
        UnknownOperation,
      );
    }
  });
});

describe("MissingErrorSchemas / DeclaredErrorType", () => {
  class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", { message: Schema.String }) {}

  const undeclared = operation({
    type: Schema.String,
    resolve: () => Effect.fail(new Boom({ message: "x" })) as Effect.Effect<string, Boom>,
  });
  const declared = operation({
    type: Schema.String,
    error: Boom,
    resolve: () => Effect.fail(new Boom({ message: "x" })) as Effect.Effect<string, Boom>,
  });
  const infallible = operation({
    type: Schema.String,
    resolve: () => Effect.succeed("ok"),
  });
  type Ops = {
    undeclared: typeof undeclared;
    declared: typeof declared;
    infallible: typeof infallible;
  };

  it("names exactly the failing operations without a declared schema", () => {
    expectTypeOf<Domain.MissingErrorSchemas<Ops>>().toEqualTypeOf<"undeclared">();
    expectTypeOf<
      Domain.MissingErrorSchemas<{ declared: typeof declared; infallible: typeof infallible }>
    >().toEqualTypeOf<never>();
  });

  it("resolves the wire error type from the declared schema", () => {
    expectTypeOf<Domain.DeclaredErrorType<typeof declared>>().toEqualTypeOf<Boom>();
    expectTypeOf<Domain.DeclaredErrorType<typeof undeclared>>().toEqualTypeOf<never>();
    expectTypeOf<Domain.DeclaredErrorType<typeof infallible>>().toEqualTypeOf<never>();
  });
});
