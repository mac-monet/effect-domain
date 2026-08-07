import { Cause, Context, Effect, Exit, Layer, Result, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  ArgsParseError,
  decodeDispatchRequest,
  field,
  Domain,
  node,
  operation,
  OperationError,
  SelectionParseError,
  subscription,
  UnknownOperation,
  WrongOperationKind,
} from "../src/index.ts";

const User = node(
  "User",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
  }),
  {
    fullName: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
  },
);

const Cat = node(
  "GatewayCat",
  Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }),
  {
    meow: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} meows`),
    }),
  },
);

const Dog = node(
  "GatewayDog",
  Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
  {
    bark: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} barks`),
    }),
  },
);

class BoomError {
  readonly _tag = "BoomError";
}

class TickService extends Context.Service<TickService, { readonly value: number }>()(
  "TickService",
) {}

function makeDomain() {
  return Domain.make({
    getUser: operation({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: ({ args }) => Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
    }),
    fail: operation({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: () => Effect.fail(new BoomError()),
    }),
    crash: operation({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: () => Effect.die("kaboom"),
    }),
    ping: operation({
      type: Schema.String,
      resolve: () => Effect.succeed("pong"),
    }),
    noArgs: operation({
      type: User,
      resolve: () => Effect.succeed({ id: "x", firstName: "A", lastName: "B" }),
    }),
    ticker: subscription({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: ({ args }) =>
        Stream.fromIterable([
          { id: `${args.id}-1`, firstName: "A", lastName: "B" },
          { id: `${args.id}-2`, firstName: "C", lastName: "D" },
        ]),
    }),
    failStream: subscription({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: () => Stream.fail(new BoomError()),
    }),
    partialFailStream: subscription({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: ({ args }) =>
        Stream.concat(
          Stream.succeed({ id: args.id, firstName: "A", lastName: "B" }),
          Stream.fail(new BoomError()),
        ),
    }),
  });
}

const domain = makeDomain();

const fuzzGraph = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) => Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
  }),
  fail: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: () => Effect.fail(new BoomError()),
  }),
  ping: operation({
    type: Schema.String,
    resolve: () => Effect.succeed("pong"),
  }),
  noArgs: operation({
    type: User,
    resolve: () => Effect.succeed({ id: "x", firstName: "A", lastName: "B" }),
  }),
  ticker: subscription({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) => Stream.make({ id: `${args.id}-1`, firstName: "A", lastName: "B" }),
  }),
  failStream: subscription({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: () => Stream.fail(new BoomError()),
  }),
});

const gatewayValue = fc.oneof(fc.constant(undefined), fc.jsonValue({ maxDepth: 3 }));
const dispatchConfig = fc.record({
  name: fc.oneof(
    fc.constantFrom("getUser", "fail", "ping", "noArgs", "ticker", "failStream"),
    fc.string({ minLength: 1, maxLength: 12 }),
  ),
  args: gatewayValue,
  select: gatewayValue,
});

function expectGatewayResult(result: Result.Result<unknown, unknown>): void {
  if (Result.isSuccess(result)) return;
  const failure = result.failure;
  expect(failure).toBeInstanceOf(Object);
  expect(
    failure instanceof UnknownOperation ||
      failure instanceof ArgsParseError ||
      failure instanceof SelectionParseError ||
      failure instanceof WrongOperationKind ||
      failure instanceof OperationError,
  ).toBe(true);
}

describe("DispatchRequestSchema", () => {
  it("carries only client data: name, args, select", async () => {
    await expect(Effect.runPromise(decodeDispatchRequest({ name: "getUser" }))).resolves.toEqual({
      name: "getUser",
    });
  });

  it("strips unknown envelope keys, including a legacy client concurrency", async () => {
    await expect(
      Effect.runPromise(
        decodeDispatchRequest({ name: "getUser", concurrency: "unbounded", extra: true }),
      ),
    ).resolves.toEqual({
      name: "getUser",
    });
  });
});

const tickGraph = Domain.make({
  needsTick: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const tick = yield* TickService;
        return { id: `${args.id}@${tick.value}`, firstName: "X", lastName: "Y" };
      }),
  }),
});

describe("dispatch — all outcomes as Result values", () => {
  it("succeeds with Result.success on valid input", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "getUser", args: { id: "1" }, select: { id: true, fullName: true } }),
    );
    expect(Result.isSuccess(out)).toBe(true);
    const tree = Result.getOrThrow(out) as Record<string, unknown>;
    expect(tree.id).toBe("1");
    expect(tree.fullName).toBe("Alice Smith");
  });

  it("scalar root succeeds with omitted select and returns the scalar directly", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "ping" }));

    expect(Result.isSuccess(out)).toBe(true);
    expect(Result.getOrThrow(out)).toBe("pong");
  });

  it("projectable root omitted select → SelectionParseError", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "getUser", args: { id: "1" } }));

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("getUser");
  });

  it("scalar root concrete select → SelectionParseError", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "ping", select: { value: true } }));

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("ping");
  });

  it("scalar array root concrete select → SelectionParseError", async () => {
    const g = Domain.make({
      listIds: operation({
        type: Schema.Array(Schema.String),
        resolve: () => Effect.succeed(["1", "2"]),
      }),
    });

    const out = await Effect.runPromise(g.dispatch({ name: "listIds", select: { id: true } }));

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("listIds");
  });

  it("undefined-valued selection entry → SelectionParseError", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "getUser", args: { id: "1" }, select: { id: undefined } }),
    );

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("getUser");
  });

  it("nested array root concrete select projects innermost objects", async () => {
    const g = Domain.make({
      listUserGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([[{ id: "1", firstName: "Nested", lastName: "User" }]]),
      }),
    });

    const out = await Effect.runPromise(
      g.dispatch({ name: "listUserGroups", select: { id: true, fullName: true } }),
    );

    expect(Result.isSuccess(out)).toBe(true);
    const groups = Result.getOrThrow(out) as ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    expect(groups[0]![0]!.id).toBe("1");
    expect(groups[0]![0]!.fullName).toBe("Nested User");
  });

  it("nullable nested array root concrete select projects present innermost objects", async () => {
    const g = Domain.make({
      maybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed([[{ id: "1", firstName: "Nested", lastName: "User" }]]),
      }),
    });

    const out = await Effect.runPromise(
      g.dispatch({ name: "maybeUserGroups", select: { id: true, fullName: true } }),
    );

    expect(Result.isSuccess(out)).toBe(true);
    const groups = Result.getOrThrow(out) as ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    expect(groups[0]![0]!.id).toBe("1");
    expect(groups[0]![0]!.fullName).toBe("Nested User");
  });

  it("array-wrapped union root concrete select projects the runtime variant", async () => {
    const g = Domain.make({
      listPets: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        args: Schema.Struct({
          variant: Schema.Union([Schema.Literal("cat"), Schema.Literal("dog")]),
        }),
        resolve: ({ args }) =>
          Effect.succeed(
            args.variant === "cat"
              ? [{ _tag: "cat" as const, name: "Whiskers" }]
              : [{ _tag: "dog" as const, name: "Rex" }],
          ),
      }),
    });

    const out = await Effect.runPromise(
      g.dispatch({
        name: "listPets",
        args: { variant: "dog" },
        select: { _tag: true, name: true, meow: true, bark: true },
      }),
    );

    expect(Result.isSuccess(out)).toBe(true);
    const rows = Result.getOrThrow(out) as ReadonlyArray<Record<string, unknown>>;
    // fields missing on the matched variant are plain undefined
    expect(rows[0]!.meow).toBeUndefined();
    expect(rows[0]!.bark).toBe("Rex barks");
  });

  it("mixed array-wrapped object/scalar union roots reject concrete selections", async () => {
    const g = Domain.make({
      listMixed: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Schema.String)]),
        resolve: () => Effect.succeed([{ _tag: "cat" as const, name: "Whiskers" }]),
      }),
    });

    const out = await Effect.runPromise(
      g.dispatch({ name: "listMixed", select: { _tag: true, name: true } }),
    );

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("listMixed");
  });

  it("E channel is never — Effect always resolves, never rejects", async () => {
    const effect = domain.dispatch({ name: "getUser", args: { id: "1" }, select: { id: true } });
    expectTypeOf(effect).toMatchTypeOf<
      Effect.Effect<Result.Result<unknown, unknown>, never, never>
    >();
  });

  it("UnknownOperation → Result.failure", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "nope", args: {}, select: {} }));
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, UnknownOperation>).failure;
    expect(err._tag).toBe("UnknownOperation");
    expect(err.operation).toBe("nope");
  });

  it("prototype operation names are UnknownOperation", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "toString", args: {}, select: {} }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, UnknownOperation>).failure;
    expect(err._tag).toBe("UnknownOperation");
    expect(err.operation).toBe("toString");
  });

  it("ArgsParseError → Result.failure with operation + cause", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "getUser", args: { id: 42 }, select: { id: true } }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, ArgsParseError>).failure;
    expect(err._tag).toBe("ArgsParseError");
    expect(err.operation).toBe("getUser");
    expect(err.cause).toBeDefined();
  });

  it("SelectionParseError → Result.failure with operation + cause", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "getUser", args: { id: "1" }, select: { bogus: true } }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, SelectionParseError>).failure;
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("getUser");
    expect(err.cause).toBeDefined();
  });

  it("operation Effect.fail(E) → Result.failure(OperationError)", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "fail", args: { id: "1" }, select: { id: true } }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, OperationError<BoomError>>).failure;
    expect(err._tag).toBe("OperationError");
    expect(err.operation).toBe("fail");
    expect((err.cause as BoomError)._tag).toBe("BoomError");
  });

  it("subscription name → WrongOperationKind", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "ticker", args: { id: "u" }, select: { id: true } }),
    );

    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, WrongOperationKind>).failure;
    expect(err._tag).toBe("WrongOperationKind");
    expect(err.operation).toBe("ticker");
    expect(err.expected).toBe("operation");
    expect(err.actual).toBe("subscription");
  });

  it("defects propagate as defects (not Result)", async () => {
    const exit = await Effect.runPromiseExit(
      domain.dispatch({ name: "crash", args: { id: "1" }, select: { id: true } }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
    }
  });

  it("preserves operation R via Effect.provide", async () => {
    const layer = Layer.succeed(TickService)({ value: 7 });
    const out = await Effect.runPromise(
      Effect.provide(
        tickGraph.dispatch({ name: "needsTick", args: { id: "u" }, select: { id: true } }),
        layer,
      ),
    );
    expect(Result.isSuccess(out)).toBe(true);
    const tree = Result.getOrThrow(out) as Record<string, unknown>;
    expect(tree.id).toBe("u@7");
  });

  it("preserves operation R via domain.provide(layer)", async () => {
    const layer = Layer.succeed(TickService)({ value: 42 });
    const out = await Effect.runPromise(
      tickGraph
        .provide(layer)
        .dispatch({ name: "needsTick", args: { id: "u" }, select: { id: true } }),
    );
    expect(Result.isSuccess(out)).toBe(true);
    const tree = Result.getOrThrow(out) as Record<string, unknown>;
    expect(tree.id).toBe("u@42");
  });

  it("property: arbitrary non-defecting dispatch inputs resolve as Result values", async () => {
    await fc.assert(
      fc.asyncProperty(dispatchConfig, async (config) => {
        const exit = await Effect.runPromiseExit(fuzzGraph.dispatch(config));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expectGatewayResult(exit.value);
        }
      }),
      { numRuns: 250 },
    );
  });
});

describe("dispatch — empty-args normalization", () => {
  it("op without args schema: omitted args is accepted", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "noArgs", select: { id: true } }));
    expect(Result.isSuccess(out)).toBe(true);
  });

  it("op without args schema: {} is accepted (equivalent to undefined)", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "noArgs", args: {}, select: { id: true } }),
    );
    expect(Result.isSuccess(out)).toBe(true);
  });

  it("op without args schema: non-empty args → ArgsParseError", async () => {
    const out = await Effect.runPromise(
      domain.dispatch({ name: "noArgs", args: { unexpected: 1 }, select: { id: true } }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, ArgsParseError>).failure;
    expect(err._tag).toBe("ArgsParseError");
    expect(err.operation).toBe("noArgs");
  });

  it("op without args schema: array args → ArgsParseError", async () => {
    const out = await Effect.runPromise(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate non-empty / wrong-shape arg
      domain.dispatch({ name: "noArgs", args: [1, 2, 3] as any, select: { id: true } }),
    );
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, ArgsParseError>).failure;
    expect(err._tag).toBe("ArgsParseError");
  });
});

describe("Domain.orFail — lifts OperationError to Effect failure channel", () => {
  it("passes Result.success through", async () => {
    const out = await Effect.runPromise(
      domain
        .dispatch({ name: "getUser", args: { id: "1" }, select: { id: true } })
        .pipe(Domain.orFail),
    );
    expect(Result.isSuccess(out)).toBe(true);
  });

  it("boundary errors stay as Result.failure(GatewayError)", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "nope" }).pipe(Domain.orFail));
    expect(Result.isFailure(out)).toBe(true);
    const err = (out as Result.Failure<unknown, UnknownOperation>).failure;
    expect(err._tag).toBe("UnknownOperation");
  });

  it("OperationError<E> moves to Effect failure channel", async () => {
    const exit = await Effect.runPromiseExit(
      domain
        .dispatch({ name: "fail", args: { id: "1" }, select: { id: true } })
        .pipe(Domain.orFail),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.findError(exit.cause);
      expect(Result.isSuccess(err)).toBe(true);
      expect((Result.getOrThrow(err) as BoomError)._tag).toBe("BoomError");
    }
  });

  it("defects still propagate as defects", async () => {
    const exit = await Effect.runPromiseExit(
      domain
        .dispatch({ name: "crash", args: { id: "1" }, select: { id: true } })
        .pipe(Domain.orFail),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
    }
  });
});

describe("dispatchSubscription — stream variant", () => {
  it("emits Result.success values on valid input", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain.dispatchSubscription({ name: "ticker", args: { id: "u" }, select: { id: true } }),
      ),
    );
    expect(chunks.length).toBe(2);
    for (const r of chunks) {
      expect(Result.isSuccess(r)).toBe(true);
    }
  });

  it("boundary error → single Result.failure element", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain.dispatchSubscription({ name: "ticker", args: { id: 99 }, select: { id: true } }),
      ),
    );
    expect(chunks.length).toBe(1);
    const err = (chunks[0] as Result.Failure<unknown, ArgsParseError>).failure;
    expect(err._tag).toBe("ArgsParseError");
  });

  it("UnknownOperation → single Result.failure element", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(domain.dispatchSubscription({ name: "nope", args: {}, select: {} })),
    );
    expect(chunks.length).toBe(1);
    const err = (chunks[0] as Result.Failure<unknown, UnknownOperation>).failure;
    expect(err._tag).toBe("UnknownOperation");
  });

  it("operation name → single WrongOperationKind element", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain.dispatchSubscription({ name: "getUser", args: { id: "u" }, select: { id: true } }),
      ),
    );

    expect(chunks.length).toBe(1);
    const err = (chunks[0] as Result.Failure<unknown, WrongOperationKind>).failure;
    expect(err._tag).toBe("WrongOperationKind");
    expect(err.operation).toBe("getUser");
    expect(err.expected).toBe("subscription");
    expect(err.actual).toBe("operation");
  });

  it("operation stream fail(E) → Result.failure(OperationError)", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain.dispatchSubscription({
          name: "failStream",
          args: { id: "1" },
          select: { id: true },
        }),
      ),
    );
    expect(chunks.length).toBe(1);
    const err = (chunks[0] as Result.Failure<unknown, OperationError<BoomError>>).failure;
    expect(err._tag).toBe("OperationError");
    expect((err.cause as BoomError)._tag).toBe("BoomError");
  });

  it("mid-stream fail(E) → prior Result.success elements then Result.failure(OperationError)", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain.dispatchSubscription({
          name: "partialFailStream",
          args: { id: "u" },
          select: { id: true },
        }),
      ),
    );
    expect(chunks.length).toBe(2);
    expect(Result.isSuccess(chunks[0]!)).toBe(true);
    const err = (chunks[1] as Result.Failure<unknown, OperationError<BoomError>>).failure;
    expect(err._tag).toBe("OperationError");
    expect((err.cause as BoomError)._tag).toBe("BoomError");
  });

  it("property: arbitrary non-defecting subscription inputs emit or fail as Result values", async () => {
    await fc.assert(
      fc.asyncProperty(dispatchConfig, async (config) => {
        const exit = await Effect.runPromiseExit(
          Stream.runCollect(fuzzGraph.dispatchSubscription(config)),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          for (const result of exit.value) {
            expectGatewayResult(result);
          }
        }
      }),
      { numRuns: 250 },
    );
  });
});

describe("Domain.orFailStream — lifts OperationError to Stream failure channel", () => {
  it("passes Result.success elements through", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        domain
          .dispatchSubscription({ name: "ticker", args: { id: "u" }, select: { id: true } })
          .pipe(Domain.orFailStream),
      ),
    );
    expect(chunks.length).toBe(2);
    for (const r of chunks) {
      expect(Result.isSuccess(r)).toBe(true);
    }
  });

  it("boundary errors stay as Result.failure elements", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(domain.dispatchSubscription({ name: "nope" }).pipe(Domain.orFailStream)),
    );
    expect(chunks.length).toBe(1);
    const err = (chunks[0] as Result.Failure<unknown, UnknownOperation>).failure;
    expect(err._tag).toBe("UnknownOperation");
  });

  it("OperationError<E> moves to Stream failure channel", async () => {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        domain
          .dispatchSubscription({ name: "failStream", args: { id: "1" }, select: { id: true } })
          .pipe(Domain.orFailStream),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.findError(exit.cause);
      expect(Result.isSuccess(err)).toBe(true);
      expect((Result.getOrThrow(err) as BoomError)._tag).toBe("BoomError");
    }
  });
});

describe("GatewayError encoding", () => {
  it("UnknownOperation is Schema-encodable with operation field", () => {
    const err = new UnknownOperation({ operation: "x" });
    const encoded = Schema.encodeUnknownSync(UnknownOperation)(err);
    expect(encoded).toEqual({ _tag: "UnknownOperation", operation: "x" });
  });

  it("ArgsParseError carries operation + cause", () => {
    const err = new ArgsParseError({ operation: "getUser", cause: "bad parse" });
    expect(err._tag).toBe("ArgsParseError");
    expect(err.operation).toBe("getUser");
    expect(err.cause).toBe("bad parse");
  });

  it("SelectionParseError carries operation + cause", () => {
    const err = new SelectionParseError({ operation: "getUser", cause: "unknown key" });
    expect(err._tag).toBe("SelectionParseError");
    expect(err.operation).toBe("getUser");
    expect(err.cause).toBe("unknown key");
  });

  it("WrongOperationKind carries operation + expected/actual kinds", () => {
    const err = new WrongOperationKind({
      operation: "ticker",
      expected: "operation",
      actual: "subscription",
    });
    expect(err._tag).toBe("WrongOperationKind");
    expect(err.operation).toBe("ticker");
    expect(err.expected).toBe("operation");
    expect(err.actual).toBe("subscription");
  });

  it("OperationError carries operation + typed cause", () => {
    const boom = new BoomError();
    const err = new OperationError("fail", boom);
    expect(err._tag).toBe("OperationError");
    expect(err.operation).toBe("fail");
    expect(err.cause).toBe(boom);
  });

  it("OperationError.schema(causeSchema) encodes live instances to the wire shape", () => {
    const Cause = Schema.Struct({ _tag: Schema.Literal("BoomError") });
    const Encoder = OperationError.schema(Cause);
    const encoded = Schema.encodeUnknownSync(Encoder)(
      new OperationError("fail", { _tag: "BoomError" }),
    );
    expect(encoded).toEqual({
      _tag: "OperationError",
      operation: "fail",
      cause: { _tag: "BoomError" },
    });
  });

  it("OperationError.schema(causeSchema) decodes to a live OperationError instance", () => {
    const Cause = Schema.Struct({ _tag: Schema.Literal("BoomError") });
    const Encoder = OperationError.schema(Cause);
    const decoded = Schema.decodeUnknownSync(Encoder)({
      _tag: "OperationError",
      operation: "fail",
      cause: { _tag: "BoomError" },
    });
    expect(decoded).toBeInstanceOf(OperationError);
    expect(decoded.operation).toBe("fail");
    expect(decoded.cause).toEqual({ _tag: "BoomError" });
  });
});
