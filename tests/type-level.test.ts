import { Effect, Option, Result, Schema, Stream } from "effect";
import { describe, expectTypeOf, it } from "vite-plus/test";
import { Domain, field, node, operation, subscription } from "../src/index.ts";
import type { SelectionFor } from "../src/index.ts";

const typecheckOnly: boolean = false;

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

describe("Unit 7: typed selections and NodeType", () => {
  it("node() return type includes both data and computed field types", () => {
    type UserType = Schema.Schema.Type<typeof User>;
    expectTypeOf<UserType>().toHaveProperty("id");
    expectTypeOf<UserType>().toHaveProperty("firstName");
    expectTypeOf<UserType>().toHaveProperty("lastName");
    expectTypeOf<UserType>().toHaveProperty("fullName");
  });

  it("SelectionFor constrains keys to valid field names", () => {
    type UserType = Schema.Schema.Type<typeof User>;
    type Sel = SelectionFor<UserType>;
    expectTypeOf<{ id: true }>().toMatchTypeOf<Sel>();
    expectTypeOf<{ fullName: true }>().toMatchTypeOf<Sel>();
    type Keys = keyof Sel;
    expectTypeOf<"id">().toMatchTypeOf<Keys>();
    expectTypeOf<"fullName">().toMatchTypeOf<Keys>();
  });

  it("NarrowBySelection excludes unselected fields", () => {
    type Narrowed = Domain.NarrowBySelection<{ id: string; name: string }, { id: true }>;
    expectTypeOf<Narrowed>().toEqualTypeOf<{ id: string }>();
  });

  it("NarrowBySelection recurses into sub-selections", () => {
    type T = { id: string; profile: { bio: string; age: number } };
    type Narrowed = Domain.NarrowBySelection<T, { id: true; profile: { select: { bio: true } } }>;
    expectTypeOf<Narrowed>().toEqualTypeOf<{ id: string; profile: { bio: string } }>();
  });

  it("ResultTree wraps scalar fields in Result", () => {
    type Tree = Domain.ResultTree<{ id: string; count: number }>;
    expectTypeOf<Tree>().toEqualTypeOf<{
      id: Result.Result<string, unknown>;
      count: Result.Result<number, unknown>;
    }>();
  });

  it("ResultTree recurses into object fields", () => {
    type Tree = Domain.ResultTree<{ profile: { bio: string } }>;
    expectTypeOf<Tree>().toEqualTypeOf<{
      profile: Result.Result<{ bio: Result.Result<string, unknown> }, unknown>;
    }>();
  });

  it("execute() return type reflects selection", () => {
    const result = domain.execute("getUser", {
      args: { id: "1" },
      select: { id: true, fullName: true },
    });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{
      id: Result.Result<string, unknown>;
      fullName: Result.Result<string, unknown>;
    }>();
  });

  it("execute() excludes unselected fields from result type", () => {
    const result = domain.execute("getUser", {
      args: { id: "1" },
      select: { id: true },
    });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{ id: Result.Result<string, unknown> }>();
  });

  it("execute() requires args for operations with args schemas", () => {
    if (typecheckOnly) {
      // @ts-expect-error getUser requires args.
      domain.execute("getUser", { select: { id: true } });
    }
    domain.execute("getUser", { args: { id: "1" }, select: { id: true } });
  });

  it("subscribe() return type reflects selection", () => {
    const g = Domain.make({
      watchUsers: subscription({
        type: User,
        args: Schema.Struct({ id: Schema.String }),
        resolve: () => Stream.make({ id: "1", firstName: "Ada", lastName: "Lovelace" }),
      }),
    });
    const result = g.subscribe("watchUsers", {
      args: { id: "1" },
      select: { id: true, fullName: true },
    });
    type R = typeof result extends Stream.Stream<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{
      id: Result.Result<string, unknown>;
      fullName: Result.Result<string, unknown>;
    }>();
  });

  it("types bind as one-shot operations and bindSubscriptions as subscriptions", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        args: Schema.Struct({ id: Schema.String }),
        resolve: () => Effect.succeed({ id: "1", firstName: "Ada", lastName: "Lovelace" }),
      }),
      watchUsers: subscription({
        type: User,
        args: Schema.Struct({ start: Schema.Number }),
        resolve: () => Stream.make({ id: "1", firstName: "Ada", lastName: "Lovelace" }),
      }),
    });

    g.bind({
      getUser: { select: { id: true } },
    });
    g.bindSubscriptions({
      watchUsers: { select: { id: true } },
    });

    if (typecheckOnly) {
      // @ts-expect-error execute only accepts one-shot operations.
      g.execute("watchUsers", { args: { start: 0 }, select: { id: true } });
      // @ts-expect-error subscribe only accepts subscriptions.
      g.subscribe("getUser", { args: { id: "1" }, select: { id: true } });
    }

    g.bind({
      // @ts-expect-error bind only accepts one-shot operations.
      watchUsers: { select: { id: true } },
    });
    g.bindSubscriptions({
      // @ts-expect-error bindSubscriptions only accepts subscriptions.
      getUser: { select: { id: true } },
    });
  });

  it("ResultOf handles nested sub-selections", () => {
    type T = { id: string; profile: { bio: string; age: number } };
    type R = Domain.ResultOf<T, { id: true; profile: { select: { bio: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{
      id: Result.Result<string, unknown>;
      profile: Result.Result<{ bio: Result.Result<string, unknown> }, unknown>;
    }>();
  });

  it("ResultOf handles array sub-selections", () => {
    type T = { items: Array<{ id: string; name: string }> };
    type R = Domain.ResultOf<T, { items: { select: { id: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{
      items: Result.Result<Array<{ id: Result.Result<string, unknown> }>, unknown>;
    }>();
  });

  it("ResultOf models null as Option.None for sub-selected fields", () => {
    type T = { profile: { bio: string } | null };
    type R = Domain.ResultOf<T, { profile: { select: { bio: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{
      profile: Result.Result<Option.None<never> | { bio: Result.Result<string, unknown> }, unknown>;
    }>();
  });

  it("ResultOf preserves null as-is for scalar selections", () => {
    type T = { name: string | null };
    type R = Domain.ResultOf<T, { name: true }>;
    expectTypeOf<R>().toEqualTypeOf<{
      name: Result.Result<string | null, unknown>;
    }>();
  });
});
