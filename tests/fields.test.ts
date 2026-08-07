import { Cause, Effect, Exit, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";
import type { Selection } from "../src/index.ts";

interface CommentFields {
  readonly body: string;
  readonly replies: ReadonlyArray<CommentFields>;
  readonly shout?: string;
}

const Comment = node(
  "Comment",
  Schema.Struct({
    body: Schema.String,
    replies: Schema.Array(Schema.suspend((): Schema.Codec<CommentFields> => Comment as any)),
  }),
  {
    shout: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(parent.body.toUpperCase()),
    }),
  },
);

async function expectDies(effect: Effect.Effect<unknown, unknown, never>): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
  }
}

describe("Unit 4: strict field failures and field args", () => {
  it("failing computed field fails the whole operation with its error", async () => {
    const Mixed = node("Mixed", Schema.Struct({ id: Schema.String }), {
      ok: field({
        type: Schema.String,
        resolve: () => Effect.succeed("works"),
      }),
      boom: field({
        type: Schema.String,
        resolve: () => Effect.fail("resolver error"),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: Mixed,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const error = await Effect.runPromise(
      Effect.flip(g.execute({ name: "get", select: { id: true, ok: true, boom: true } })),
    );

    expect(error).toBe("resolver error");
  });

  it("any of multiple failing computed fields fails the operation", async () => {
    const Multi = node("Multi", Schema.Struct({ id: Schema.String }), {
      a: field({ type: Schema.String, resolve: () => Effect.fail("error-a") }),
      b: field({ type: Schema.String, resolve: () => Effect.fail("error-b") }),
      c: field({ type: Schema.String, resolve: () => Effect.succeed("ok") }),
    });

    const g = Domain.make({
      get: operation({ type: Multi, resolve: () => Effect.succeed({ id: "1" }) }),
    });

    const error = await Effect.runPromise(
      Effect.flip(g.execute({ name: "get", select: { id: true, a: true, b: true, c: true } })),
    );

    expect(["error-a", "error-b"]).toContain(error);
  });

  it("field args decoded and available in resolver", async () => {
    const WithArgs = node("WithArgs", Schema.Struct({ id: Schema.String }), {
      greeting: field({
        type: Schema.String,
        args: Schema.Struct({ name: Schema.String }),
        resolve: ({ parent, args }) => Effect.succeed(`Hello, ${args.name} (${parent.id})!`),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithArgs,
        resolve: () => Effect.succeed({ id: "42" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { greeting: { args: { name: "Alice" } } } }),
    );

    expect(result.greeting).toBe("Hello, Alice (42)!");
  });

  it("invalid field args in-process die as caller misuse", async () => {
    const WithArgs = node("WithArgs", Schema.Struct({ id: Schema.String }), {
      greeting: field({
        type: Schema.String,
        args: Schema.Struct({ name: Schema.String }),
        resolve: ({ args }) => Effect.succeed(`Hello, ${args.name}!`),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithArgs,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      g.execute({ name: "get", select: { greeting: { args: { name: 123 } } } }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
  });

  it("transforming args codecs decode exactly once through dispatch", async () => {
    const WithArgs = node("TransformArgs", Schema.Struct({ id: Schema.String }), {
      double: field({
        type: Schema.Number,
        args: Schema.Struct({ n: Schema.FiniteFromString }),
        resolve: ({ args }) => Effect.succeed(args.n * 2),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithArgs,
        error: Schema.Never,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.dispatch({ name: "get", select: { double: { args: { n: "21" } } } }),
    );
    expect(Result.getOrThrow(result)).toEqual({ double: 42 });

    const bad = await Effect.runPromise(
      g.dispatch({ name: "get", select: { double: { args: { n: "nope" } } } }),
    );
    expect(Result.isFailure(bad) && bad.failure._tag).toBe("SelectionParseError");
  });

  it("alias renames the output key", async () => {
    const WithAlias = node("WithAlias", Schema.Struct({ id: Schema.String }), {
      greeting: field({
        type: Schema.String,
        resolve: () => Effect.succeed("hello"),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithAlias,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { greeting: { alias: "hi" } } as Selection }),
    );

    expect((result as any).hi).toBe("hello");
    expect("greeting" in result).toBe(false);
  });

  it("prototype-name aliases are ordinary output keys", async () => {
    const WithAlias = node("PrototypeAlias", Schema.Struct({ id: Schema.String }), {
      greeting: field({
        type: Schema.String,
        resolve: () => Effect.succeed("hello"),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithAlias,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { greeting: { alias: "__proto__" } } as Selection }),
    );

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect((result as Record<string, unknown>).__proto__).toBe("hello");
  });

  it("multi-alias array form selects same field with different args", async () => {
    const WithAlias = node("WithAlias", Schema.Struct({ id: Schema.String }), {
      users: field({
        type: Schema.Array(Schema.Struct({ name: Schema.String })),
        args: Schema.Struct({ role: Schema.String }),
        resolve: ({ args }) => Effect.succeed([{ name: `${args.role}-user` }]),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: WithAlias,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({
        name: "get",
        select: {
          users: [
            { args: { role: "user" }, select: { name: true } },
            { args: { role: "admin" }, alias: "admins", select: { name: true } },
          ],
        } as Selection,
      }),
    );

    expect((result as any).users).toEqual([{ name: "user-user" }]);
    expect((result as any).admins).toEqual([{ name: "admin-user" }]);
  });

  it("field without args schema dies on selection args (caller misuse)", async () => {
    const NoArgs = node("NoArgs", Schema.Struct({ id: Schema.String }), {
      value: field({
        type: Schema.String,
        resolve: () => Effect.succeed("no-args"),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: NoArgs,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    await expectDies(g.execute({ name: "get", select: { value: { args: { unexpected: true } } } }));
  });

  it("data fields die on selection args (caller misuse)", async () => {
    const Plain = node("PlainArgs", Schema.Struct({ id: Schema.String }), {});

    const g = Domain.make({
      get: operation({
        type: Plain,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    await expectDies(g.execute({ name: "get", select: { id: { args: { unexpected: true } } } }));
  });
});

describe("Recursive (Suspend) schemas", () => {
  it("walks recursive data fields with computed fields", async () => {
    const g = Domain.make({
      getThread: operation({
        type: Comment,
        resolve: () =>
          Effect.succeed({
            body: "hello",
            replies: [
              { body: "world", replies: [] },
              { body: "nested", replies: [{ body: "deep", replies: [] }] },
            ],
          }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({
        name: "getThread",
        select: {
          body: true,
          shout: true,
          replies: {
            select: {
              body: true,
              shout: true,
              replies: { select: { body: true, shout: true } },
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      body: "hello",
      shout: "HELLO",
      replies: [
        { body: "world", shout: "WORLD", replies: [] },
        {
          body: "nested",
          shout: "NESTED",
          replies: [{ body: "deep", shout: "DEEP" }],
        },
      ],
    });
  });
});
