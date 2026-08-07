import { Effect, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { OperationError } from "../../src/index.ts";
import { domain, KSUserNotFound, makeLive } from "./domain.ts";

const liveDomain = domain.provide(makeLive());

describe("kitchen sink: dispatch", () => {
  it("single envelope returns a Result with the projected value", async () => {
    const result = await Effect.runPromise(
      liveDomain.dispatch({
        name: "getUser",
        args: { id: "u1" },
        select: { fullName: true, posts: { select: { title: true } } },
      }),
    );
    expect(Result.isSuccess(result)).toBe(true);
    // dispatch's success value is `unknown` by design (untrusted boundary).
    const user = Result.getOrThrow(result) as { fullName: string; posts: { title: string }[] };
    expect(user.fullName).toBe("Ada Lovelace");
    expect(user.posts).toHaveLength(2);
  });

  it("array form mixes per-envelope success and failure without fail-fast", async () => {
    const [failed, count, feed] = await Effect.runPromise(
      liveDomain.dispatch([
        { name: "getUser", args: { id: "missing" }, select: { id: true } },
        { name: "countUsers" },
        { name: "getFeed", args: { id: "f1" }, select: { id: true } },
      ]),
    );

    // Narrow instead of cast so the declared error union stays type-checked.
    if (!Result.isFailure(failed!)) throw new Error("expected a per-envelope failure");
    const error = failed.failure;
    if (!(error instanceof OperationError)) throw new Error("expected OperationError");
    expect(error.cause).toBeInstanceOf(KSUserNotFound);

    expect(Result.getOrThrow(count!)).toBe(3);
    expect(Result.getOrThrow(feed!)).toEqual({ id: "f1" });
  });
});

describe("kitchen sink: prepareDispatch", () => {
  it("analyzes a deep dynamic invocation before execution", async () => {
    const prepared = await Effect.runPromise(
      liveDomain.prepareDispatch({
        name: "getUser",
        args: { id: "u1" },
        select: {
          id: true,
          posts: { select: { title: true, comments: { select: { body: true } } } },
        },
      }),
    );

    expect(prepared.name).toBe("getUser");
    expect(prepared.analysis.depth).toBe(3);
    expect(prepared.analysis.fields.map((field) => field.path.join("."))).toEqual([
      "id",
      "posts",
      "posts.title",
      "posts.comments",
      "posts.comments.body",
    ]);

    const result = await Effect.runPromise(prepared.execute());
    expect(Result.isSuccess(result)).toBe(true);
  });
});

describe("kitchen sink: handleDispatch", () => {
  it("encodes a deep success into the wire envelope", async () => {
    const encoded = await Effect.runPromise(
      liveDomain.handleDispatch({
        name: "getUser",
        args: { id: "u1" },
        select: { fullName: true, posts: { select: { author: { select: { id: true } } } } },
      }),
    );
    expect(encoded).toMatchObject({
      _tag: "Success",
      success: {
        fullName: "Ada Lovelace",
        posts: [{ author: { id: "u1" } }, { author: { id: "u1" } }],
      },
    });
  });

  it("keeps malformed envelopes in the envelope, not the error channel", async () => {
    const [unknown, badArgs, noSelect, extraKey] = await Effect.runPromise(
      liveDomain.handleDispatch([
        { name: "nope" },
        { name: "getUser", args: { id: 42 }, select: { id: true } },
        // Node root with omitted select must be rejected.
        { name: "getUser", args: { id: "u1" } },
        // Unknown selection key at depth.
        { name: "getUser", args: { id: "u1" }, select: { posts: { select: { bogus: true } } } },
      ]),
    );

    expect(unknown).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownOperation" } });
    expect(badArgs).toMatchObject({ _tag: "Failure", failure: { _tag: "ArgsParseError" } });
    expect(noSelect).toMatchObject({ _tag: "Failure", failure: { _tag: "SelectionParseError" } });
    expect(extraKey).toMatchObject({ _tag: "Failure", failure: { _tag: "SelectionParseError" } });
  });

  it("single-envelope form carries declared errors inside the envelope", async () => {
    const encoded = await Effect.runPromise(
      liveDomain.handleDispatch({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
    );
    expect(encoded).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OperationError", cause: { _tag: "KSUserNotFound", id: "missing" } },
    });
  });
});
