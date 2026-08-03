import { Effect, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserNotFound, UserRepoLive } from "../examples/domain.ts";
import { OperationError, UnknownOperation } from "../src/index.ts";

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
    const user = (decoded as Result.Success<Record<string, Result.Result<string, never>>, never>)
      .success;
    expect(Result.getOrThrow(user.id)).toBe("1");
    expect(Result.getOrThrow(user.fullName)).toBe("Alice Anderson");
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
