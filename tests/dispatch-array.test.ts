import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, operation, OperationError } from "../src/index.ts";

class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", {
  message: Schema.String,
}) {}

const domain = Domain.make({
  greet: operation({
    type: Schema.String,
    args: Schema.Struct({ name: Schema.String }),
    error: Boom,
    resolve: ({ args }) =>
      args.name === "boom"
        ? Effect.fail(new Boom({ message: "nope" }))
        : Effect.succeed(`hello ${args.name}`),
  }),
  countUsers: operation({
    type: Schema.Number,
    resolve: () => Effect.succeed(2),
  }),
});

describe("dispatch array overload", () => {
  it("returns per-entry Results with no fail-fast — failure sits beside success", async () => {
    const [failed, succeeded] = await Effect.runPromise(
      domain.dispatch([{ name: "greet", args: { name: "boom" } }, { name: "countUsers" }]),
    );

    expect(Result.isFailure(failed!)).toBe(true);
    const error = (failed as Result.Failure<unknown, OperationError<Boom>>).failure;
    expect(error).toBeInstanceOf(OperationError);
    expect(error.cause).toBeInstanceOf(Boom);

    expect(Result.isSuccess(succeeded!)).toBe(true);
    expect(Result.getOrThrow(succeeded!)).toBe(2);
  });

  it("empty array short-circuits to []", async () => {
    expect(await Effect.runPromise(domain.dispatch([]))).toEqual([]);
  });

  it("single-envelope form is unaffected", async () => {
    const out = await Effect.runPromise(domain.dispatch({ name: "greet", args: { name: "Ada" } }));
    expect(Result.isSuccess(out)).toBe(true);
    expect(Result.getOrThrow(out)).toBe("hello Ada");
  });
});

describe("handleDispatch array overload", () => {
  it("returns encoded envelopes in order with failures inside their own envelope", async () => {
    const [ok, failed, count] = await Effect.runPromise(
      domain.handleDispatch([
        { name: "greet", args: { name: "Ada" } },
        { name: "greet", args: { name: "boom" } },
        { name: "countUsers" },
      ]),
    );

    expect(ok).toMatchObject({ _tag: "Success", success: "hello Ada" });
    expect(failed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OperationError", cause: { _tag: "Boom", message: "nope" } },
    });
    expect(count).toMatchObject({ _tag: "Success", success: 2 });
  });

  it("empty array short-circuits to []", async () => {
    expect(await Effect.runPromise(domain.handleDispatch([]))).toEqual([]);
  });

  it("single-envelope form is unaffected", async () => {
    const encoded = await Effect.runPromise(
      domain.handleDispatch({ name: "greet", args: { name: "Ada" } }),
    );
    expect(encoded).toMatchObject({ _tag: "Success", success: "hello Ada" });
  });
});
