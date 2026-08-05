import { Context, Effect, Schema, Stream } from "effect";
import { describe, expectTypeOf, it } from "vite-plus/test";
import { Domain, field, node, operation, subscription } from "../src/index.ts";
import type { SelectionFor } from "../src/index.ts";
import type { AllR, NodeDeclaredE, NodeE, NodeR } from "../src/domain/type-level.ts";

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

  it("SelectedOf excludes unselected fields", () => {
    type Narrowed = Domain.SelectedOf<{ id: string; name: string }, { id: true }>;
    expectTypeOf<Narrowed>().toEqualTypeOf<{ id: string }>();
  });

  it("SelectedOf recurses into sub-selections", () => {
    type T = { id: string; profile: { bio: string; age: number } };
    type Narrowed = Domain.SelectedOf<T, { id: true; profile: { select: { bio: true } } }>;
    expectTypeOf<Narrowed>().toEqualTypeOf<{ id: string; profile: { bio: string } }>();
  });

  it("execute() return type reflects selection", () => {
    const result = domain.execute("getUser", {
      args: { id: "1" },
      select: { id: true, fullName: true },
    });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{ id: string; fullName: string }>();
  });

  it("execute() excludes unselected fields from result type", () => {
    const result = domain.execute("getUser", {
      args: { id: "1" },
      select: { id: true },
    });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{ id: string }>();
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
    expectTypeOf<R>().toEqualTypeOf<{ id: string; fullName: string }>();
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

  it("SelectedOf handles array sub-selections", () => {
    type T = { items: Array<{ id: string; name: string }> };
    type R = Domain.SelectedOf<T, { items: { select: { id: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{ items: Array<{ id: string }> }>();
  });

  it("SelectedOf models null as null for sub-selected fields", () => {
    type T = { profile: { bio: string } | null };
    type R = Domain.SelectedOf<T, { profile: { select: { bio: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{ profile: null | { bio: string } }>();
  });

  it("SelectedOf models missing-on-variant sub-selected fields as undefined", () => {
    // The walker emits `undefined` for a selected field absent from the
    // matched union variant — distinct from nullish values, which it
    // normalizes to `null`.
    type T = { _tag: "cat" } | { _tag: "dog"; house: { size: number } };
    type R = Domain.SelectedOf<T, { house: { select: { size: true } } }>;
    expectTypeOf<R>().toEqualTypeOf<{ house: undefined | { size: number } }>();
  });

  it("Node extractors see union variants, anonymous-struct roots, and declared field errors", () => {
    class CatSvc extends Context.Service<CatSvc, { readonly c: number }>()("CatSvc") {}
    class DogErr extends Schema.TaggedErrorClass<DogErr>("DogErr")("DogErr", {}) {}

    const Cat = node("TLCat", Schema.Struct({ _tag: Schema.Literal("cat") }), (f) => ({
      purr: f.field({
        type: Schema.Number,
        resolve: () =>
          Effect.gen(function* () {
            const { c } = yield* CatSvc;
            return c;
          }),
      }),
    }));
    const Dog = node("TLDog", Schema.Struct({ _tag: Schema.Literal("dog") }), (f) => ({
      bark: f.field({
        type: Schema.String,
        error: DogErr,
        resolve: () => Effect.fail(new DogErr()),
      }),
    }));
    type Pet = Schema.Schema.Type<typeof Cat> | Schema.Schema.Type<typeof Dog>;

    // Variant-specific fields survive the union (keyof-intersection would drop both).
    expectTypeOf<NodeR<Pet>>().toEqualTypeOf<CatSvc>();
    expectTypeOf<NodeE<Pet>>().toEqualTypeOf<DogErr>();
    // Declared field error Types feed the wire failure union.
    expectTypeOf<NodeDeclaredE<Pet>>().toEqualTypeOf<DogErr>();

    // A node nested under an anonymous struct root still contributes.
    type AnonRoot = { readonly pet: Schema.Schema.Type<typeof Cat> };
    expectTypeOf<NodeR<AnonRoot>>().toEqualTypeOf<CatSvc>();
  });

  it("SelectedOf preserves null as-is for scalar selections", () => {
    type T = { name: string | null };
    type R = Domain.SelectedOf<T, { name: true }>;
    expectTypeOf<R>().toEqualTypeOf<{ name: string | null }>();
  });

  it("field requirements and errors reach the type level through NodeMeta", () => {
    class Clock extends Context.Service<Clock, { readonly now: number }>()("Clock") {}
    class Fmt extends Context.Service<Fmt, { readonly fmt: string }>()("Fmt") {}
    class BioMissing extends Schema.TaggedErrorClass<BioMissing>("BioMissing")("BioMissing", {}) {}

    const Profile = node("Profile", Schema.Struct({ bio: Schema.String }), (f) => ({
      formatted: f.field({
        type: Schema.String,
        resolve: ({ parent }) =>
          Effect.gen(function* () {
            const { fmt } = yield* Fmt;
            if (parent.bio === "") return yield* new BioMissing();
            return `${fmt}${parent.bio}`;
          }),
      }),
    }));

    const TimedUser = node("TimedUser", Schema.Struct({ id: Schema.String }), (f) => ({
      stampedAt: f.field({
        type: Schema.Number,
        resolve: () =>
          Effect.gen(function* () {
            const { now } = yield* Clock;
            return now;
          }),
      }),
      profiles: f.field({
        type: Schema.Array(Profile),
        resolve: () => Effect.succeed([]),
      }),
    }));

    type T = Schema.Schema.Type<typeof TimedUser>;
    // Own field R plus nested node field R, through the array.
    expectTypeOf<NodeR<T>>().toEqualTypeOf<Clock | Fmt>();
    // NodeE mirrors it for errors and feeds OperationE, execute's error channel.
    expectTypeOf<NodeE<T>>().toEqualTypeOf<BioMissing>();
    // The phantom key is a symbol: selection syntax never offers it.
    expectTypeOf<keyof SelectionFor<T>>().toEqualTypeOf<"id" | "stampedAt" | "profiles">();

    // The undercount fix: field R surfaces in execute R and AllR even though
    // the operation resolver itself requires nothing.
    const g = Domain.make({
      getTimed: operation({
        type: TimedUser,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    type GR = AllR<(typeof g)["operations"]>;
    expectTypeOf<GR>().toEqualTypeOf<Clock | Fmt>();
    const eff = g.execute("getTimed", { select: { stampedAt: true } });
    type ER = typeof eff extends Effect.Effect<any, any, infer R> ? R : never;
    expectTypeOf<ER>().toEqualTypeOf<Clock | Fmt>();
  });
});
