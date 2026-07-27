import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

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

const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) => Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
  }),
});

describe("Unit 1: minimal e2e", () => {
  it("resolves a computed field via execute()", async () => {
    const result = await Effect.runPromise(
      domain.execute("getUser", {
        args: { id: "1" },
        select: { id: true, fullName: true },
      }),
    );

    expect(Result.isSuccess(result.id)).toBe(true);
    expect(Result.isSuccess(result.fullName)).toBe(true);
    expect(Result.getOrThrow(result.id)).toBe("1");
    expect(Result.getOrThrow(result.fullName)).toBe("Alice Smith");
  });

  it("returns plain data fields via property access", async () => {
    const result = await Effect.runPromise(
      domain.execute("getUser", {
        args: { id: "2" },
        select: { id: true, firstName: true, lastName: true },
      }),
    );

    expect(Result.getOrThrow(result.id)).toBe("2");
    expect(Result.getOrThrow(result.firstName)).toBe("Alice");
    expect(Result.getOrThrow(result.lastName)).toBe("Smith");
  });

  it("excludes unselected fields from result", async () => {
    const result = await Effect.runPromise(
      domain.execute("getUser", {
        args: { id: "3" },
        select: { id: true },
      }),
    );

    expect(Result.isSuccess(result.id)).toBe(true);
    expect("fullName" in result).toBe(false);
    expect("firstName" in result).toBe(false);
    expect("lastName" in result).toBe(false);
  });

  it("passes selections set to operation resolver", async () => {
    let receivedSelections: ReadonlySet<string> | undefined;

    const g = Domain.make({
      getUser: operation({
        type: User,
        args: Schema.Struct({ id: Schema.String }),
        resolve: ({ args, selections }) => {
          receivedSelections = selections;
          return Effect.succeed({
            id: args.id,
            firstName: "Alice",
            lastName: "Smith",
          });
        },
      }),
    });

    await Effect.runPromise(
      g.execute("getUser", {
        args: { id: "1" },
        select: { id: true, fullName: true },
      }),
    );

    expect(receivedSelections).toEqual(new Set(["id", "fullName"]));
  });

  it("passes selections set to field resolver", async () => {
    let receivedSelections: ReadonlySet<string> | undefined;

    const Profile = node("Profile", Schema.Struct({ bio: Schema.String }), {});

    const UserWithProfile = node("UserWithProfile", Schema.Struct({ id: Schema.String }), {
      profile: field({
        type: Profile,
        resolve: (ctx) => {
          receivedSelections = ctx.selections;
          return Effect.succeed({ bio: "hello" });
        },
      }),
    });

    const g = Domain.make({
      getUser: operation({
        type: UserWithProfile,
        args: Schema.Struct({ id: Schema.String }),
        resolve: ({ args }) => Effect.succeed({ id: args.id }),
      }),
    });

    await Effect.runPromise(
      g.execute("getUser", {
        args: { id: "1" },
        select: { profile: { select: { bio: true } } },
      }),
    );

    expect(receivedSelections).toEqual(new Set(["bio"]));
  });

  it("works with node() factory callback style", async () => {
    const FactoryUser = node(
      "FactoryUser",
      Schema.Struct({ first: Schema.String, last: Schema.String }),
      (f) => ({
        full: f.field({
          type: Schema.String,
          resolve: ({ parent }) => Effect.succeed(`${parent.first} ${parent.last}`),
        }),
      }),
    );

    const g = Domain.make({
      get: operation({
        type: FactoryUser,
        resolve: () => Effect.succeed({ first: "Bob", last: "Jones" }),
      }),
    });

    const result = await Effect.runPromise(g.execute("get", { select: { full: true } }));

    expect(Result.getOrThrow(result.full)).toBe("Bob Jones");
  });

  it("executes operation with no args", async () => {
    const g = Domain.make({
      ping: operation({
        type: Schema.Struct({ ok: Schema.Boolean }),
        resolve: () => Effect.succeed({ ok: true }),
      }),
    });

    const result = await Effect.runPromise(g.execute("ping", { select: { ok: true } }));

    expect(Result.getOrThrow(result.ok)).toBe(true);
  });

  it("wraps failing resolver in Result.Failure", async () => {
    const Failing = node("Failing", Schema.Struct({ id: Schema.String }), {
      boom: field({
        type: Schema.String,
        resolve: () => Effect.fail("resolver error"),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: Failing,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(g.execute("get", { select: { id: true, boom: true } }));

    expect(Result.isSuccess(result.id)).toBe(true);
    expect(Result.isFailure(result.boom)).toBe(true);
  });

  it("infers operation name from record key", () => {
    const g = Domain.make({
      myOp: operation({
        type: Schema.Struct({ id: Schema.String }),
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    expect(g.operations).toHaveProperty("myOp");
  });
});
