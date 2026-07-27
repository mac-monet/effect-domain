import { Effect, Result, Schema } from "effect";
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

describe("Unit 4: partial success and field args", () => {
  it("failing computed field produces Result.Failure, siblings still succeed", async () => {
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

    const result = await Effect.runPromise(
      g.execute("get", { select: { id: true, ok: true, boom: true } }),
    );

    expect(Result.isSuccess(result.id)).toBe(true);
    expect(Result.getOrThrow(result.id)).toBe("1");
    expect(Result.isSuccess(result.ok)).toBe(true);
    expect(Result.getOrThrow(result.ok)).toBe("works");
    expect(Result.isFailure(result.boom)).toBe(true);
  });

  it("multiple computed fields fail independently", async () => {
    const Multi = node("Multi", Schema.Struct({ id: Schema.String }), {
      a: field({ type: Schema.String, resolve: () => Effect.fail("error-a") }),
      b: field({ type: Schema.String, resolve: () => Effect.fail("error-b") }),
      c: field({ type: Schema.String, resolve: () => Effect.succeed("ok") }),
    });

    const g = Domain.make({
      get: operation({ type: Multi, resolve: () => Effect.succeed({ id: "1" }) }),
    });

    const result = await Effect.runPromise(
      g.execute("get", { select: { id: true, a: true, b: true, c: true } }),
    );

    expect(Result.isSuccess(result.id)).toBe(true);
    expect(Result.isFailure(result.a)).toBe(true);
    expect(Result.isFailure(result.b)).toBe(true);
    expect(Result.isSuccess(result.c)).toBe(true);
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
      g.execute("get", {
        select: { greeting: { args: { name: "Alice" } } },
      }),
    );

    expect(Result.getOrThrow(result.greeting)).toBe("Hello, Alice (42)!");
  });

  it("invalid field args produce Result.Failure", async () => {
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

    const result = await Effect.runPromise(
      g.execute("get", {
        select: { greeting: { args: { name: 123 } } },
      }),
    );

    expect(Result.isFailure(result.greeting)).toBe(true);
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
      g.execute("get", {
        select: { greeting: { alias: "hi" } } as Selection,
      }),
    );

    expect(Result.getOrThrow((result as any).hi)).toBe("hello");
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
      g.execute("get", {
        select: { greeting: { alias: "__proto__" } } as Selection,
      }),
    );

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(
      Result.getOrThrow((result as Record<string, Result.Result<unknown, unknown>>).__proto__),
    ).toBe("hello");
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
      g.execute("get", {
        select: {
          users: [
            { args: { role: "user" }, select: { name: true } },
            { args: { role: "admin" }, alias: "admins", select: { name: true } },
          ],
        } as Selection,
      }),
    );

    const users = Result.getOrThrow((result as any).users) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(users).toHaveLength(1);
    expect(Result.getOrThrow(users[0].name)).toBe("user-user");

    const admins = Result.getOrThrow((result as any).admins) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(admins).toHaveLength(1);
    expect(Result.getOrThrow(admins[0].name)).toBe("admin-user");
  });

  it("field without args schema rejects selection args", async () => {
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

    const result = await Effect.runPromise(
      g.execute("get", {
        select: { value: { args: { unexpected: true } } },
      }),
    );

    expect(Result.isFailure(result.value)).toBe(true);
  });

  it("data fields reject selection args", async () => {
    const Plain = node("PlainArgs", Schema.Struct({ id: Schema.String }), {});

    const g = Domain.make({
      get: operation({
        type: Plain,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("get", {
        select: { id: { args: { unexpected: true } } },
      }),
    );

    expect(Result.isFailure(result.id)).toBe(true);
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
      g.execute("getThread", {
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

    expect(Result.getOrThrow(result.body)).toBe("hello");
    expect(Result.getOrThrow(result.shout)).toBe("HELLO");

    const replies = Result.getOrThrow(result.replies) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(replies).toHaveLength(2);
    expect(Result.getOrThrow(replies[0].body)).toBe("world");
    expect(Result.getOrThrow(replies[0].shout)).toBe("WORLD");

    const nested = Result.getOrThrow(replies[1].replies) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(nested).toHaveLength(1);
    expect(Result.getOrThrow(nested[0].body)).toBe("deep");
    expect(Result.getOrThrow(nested[0].shout)).toBe("DEEP");
  });
});
