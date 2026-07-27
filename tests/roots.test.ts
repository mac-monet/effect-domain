import { Effect, Option, Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";
import type { RootSelectionFor } from "../src/index.ts";

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

const Cat = node("Cat", Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }), {
  meow: field({
    type: Schema.String,
    resolve: ({ parent }) => Effect.succeed(`${parent.name} says meow`),
  }),
});

const Dog = node("Dog", Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }), {
  bark: field({
    type: Schema.String,
    resolve: ({ parent }) => Effect.succeed(`${parent.name} says woof`),
  }),
});

const Pet = Schema.Union([Cat, Dog]);

describe("Unit 12: root output generalization", () => {
  it("projects each element for array object roots", async () => {
    const g = Domain.make({
      listUsers: operation({
        type: Schema.Array(User),
        resolve: () =>
          Effect.succeed([
            { id: "1", firstName: "Alice", lastName: "Smith" },
            { id: "2", firstName: "Bob", lastName: "Jones" },
          ]),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("listUsers", { select: { id: true, fullName: true } }),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(Result.getOrThrow(result[0]!.id)).toBe("1");
    expect(Result.getOrThrow(result[0]!.fullName)).toBe("Alice Smith");
    expect(Result.getOrThrow(result[1]!.id)).toBe("2");
    expect(Result.getOrThrow(result[1]!.fullName)).toBe("Bob Jones");
  });

  it("maps nullish elements to Option.none for arrays of nullable object roots", async () => {
    const g = Domain.make({
      listUsers: operation({
        type: Schema.Array(Schema.NullOr(User)),
        resolve: () =>
          Effect.succeed([
            { id: "1", firstName: "Alice", lastName: "Smith" },
            null,
            { id: "2", firstName: "Bob", lastName: "Jones" },
          ]),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("listUsers", { select: { id: true, fullName: true } }),
    );

    const first = result[0] as Record<string, Result.Result<unknown, unknown>>;
    const third = result[2] as Record<string, Result.Result<unknown, unknown>>;
    expect(Result.getOrThrow(first.id!)).toBe("1");
    expect(Option.isNone(result[1] as Option.Option<never>)).toBe(true);
    expect(Result.getOrThrow(third.fullName!)).toBe("Bob Jones");
  });

  it("executes scalar roots without select and returns the scalar directly", async () => {
    const g = Domain.make({
      countUsers: operation({
        type: Schema.Number,
        resolve: () => Effect.succeed(2),
      }),
    });

    const result = await Effect.runPromise(g.execute("countUsers", {}));

    expect(result).toBe(2);
  });

  it("executes scalar array roots without select and returns the array directly", async () => {
    const g = Domain.make({
      listIds: operation({
        type: Schema.Array(Schema.String),
        resolve: () => Effect.succeed(["1", "2"]),
      }),
    });

    const result = await Effect.runPromise(g.execute("listIds", {}));

    expect(result).toEqual(["1", "2"]);
  });

  it("projects nested array object roots", async () => {
    const g = Domain.make({
      listUserGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([[{ id: "1", firstName: "Nested", lastName: "User" }]]),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("listUserGroups", { select: { id: true, fullName: true } }),
    );
    const groups = result as unknown as ReadonlyArray<
      ReadonlyArray<Record<string, Result.Result<unknown, unknown>>>
    >;

    expect(Result.getOrThrow(groups[0]![0]!.id)).toBe("1");
    expect(Result.getOrThrow(groups[0]![0]!.fullName)).toBe("Nested User");
  });

  it("projects present nullable nested array roots", async () => {
    const g = Domain.make({
      maybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed([[{ id: "1", firstName: "Nested", lastName: "User" }]]),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("maybeUserGroups", { select: { id: true, fullName: true } }),
    );
    const groups = result as unknown as ReadonlyArray<
      ReadonlyArray<Record<string, Result.Result<unknown, unknown>>>
    >;

    expect(Result.getOrThrow(groups[0]![0]!.id)).toBe("1");
    expect(Result.getOrThrow(groups[0]![0]!.fullName)).toBe("Nested User");
  });

  it("returns Option.none for absent nullable nested array roots", async () => {
    const g = Domain.make({
      maybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed(null),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("maybeUserGroups", { select: { id: true, fullName: true } }),
    );

    expect(Option.isNone(result as Option.Option<never>)).toBe(true);
  });

  it("returns Option.none for absent nullable object roots", async () => {
    const g = Domain.make({
      getMaybeUser: operation({
        type: Schema.NullOr(User),
        resolve: () => Effect.succeed(null),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getMaybeUser", { select: { id: true, fullName: true } }),
    );

    expect(Option.isNone(result as Option.Option<never>)).toBe(true);
  });

  it("projects present nullable object roots", async () => {
    const g = Domain.make({
      getMaybeUser: operation({
        type: Schema.NullOr(User),
        resolve: () => Effect.succeed({ id: "1", firstName: "Alice", lastName: "Smith" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getMaybeUser", { select: { id: true, fullName: true } }),
    );

    expect(Option.isNone(result as Option.Option<never>)).toBe(false);
    const tree = result as Record<string, Result.Result<unknown, unknown>>;
    expect(Result.getOrThrow(tree.id!)).toBe("1");
  });

  it("projects present nullable array roots", async () => {
    const g = Domain.make({
      getMaybeUsers: operation({
        type: Schema.NullOr(Schema.Array(User)),
        resolve: () => Effect.succeed([{ id: "1", firstName: "Alice", lastName: "Smith" }]),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getMaybeUsers", { select: { id: true, fullName: true } }),
    );

    const rows = result as ReadonlyArray<Record<string, Result.Result<unknown, unknown>>>;
    expect(Result.getOrThrow(rows[0]!.fullName)).toBe("Alice Smith");
  });

  it("preserves flat merged object-union root selections", async () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getPet", { select: { _tag: true, name: true, meow: true, bark: true } }),
    );

    expect(Result.getOrThrow(result._tag)).toBe("dog");
    expect(Result.getOrThrow((result as any).bark)).toBe("Rex says woof");
    expect("meow" in result).toBe(true);
    expect(Result.getOrThrow((result as any).meow)).toBeUndefined();
  });

  it("preserves undefined for nested selections on fields missing from the runtime union variant", async () => {
    const Toy = node("UnionMissingToy", Schema.Struct({ name: Schema.String }), {});
    const CatWithToys = node(
      "UnionMissingCat",
      Schema.Struct({
        _tag: Schema.Literal("cat"),
        name: Schema.String,
        toys: Schema.Array(Toy),
      }),
      {},
    );
    const DogWithoutToys = node(
      "UnionMissingDog",
      Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
      {},
    );
    const PetWithVariantField = Schema.Union([CatWithToys, DogWithoutToys]);
    const g = Domain.make({
      getPet: operation({
        type: PetWithVariantField,
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getPet", {
        select: { _tag: true, toys: { select: { name: true } } } as never,
      }),
    );

    expect(Result.getOrThrow((result as any).toys)).toBeUndefined();
  });

  it("preserves undefined for nested selections on missing fields inside nested union values", async () => {
    const Toy = node("NestedUnionMissingToy", Schema.Struct({ name: Schema.String }), {});
    const CatWithToys = node(
      "NestedUnionMissingCat",
      Schema.Struct({
        _tag: Schema.Literal("cat"),
        name: Schema.String,
        toys: Schema.Array(Toy),
      }),
      {},
    );
    const DogWithoutToys = node(
      "NestedUnionMissingDog",
      Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
      {},
    );
    const PetWithVariantField = Schema.Union([CatWithToys, DogWithoutToys]);
    const Owner = node(
      "NestedUnionMissingOwner",
      Schema.Struct({ id: Schema.String, pet: PetWithVariantField }),
      {},
    );
    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () =>
          Effect.succeed({
            id: "1",
            pet: { _tag: "dog" as const, name: "Rex" },
          }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getOwner", {
        select: { pet: { select: { _tag: true, toys: { select: { name: true } } } } } as never,
      }),
    );

    const pet = Result.getOrThrow(result.pet) as Record<string, Result.Result<unknown, unknown>>;
    expect(Result.getOrThrow(pet.toys)).toBeUndefined();
  });

  it("types object-union root results with variant-only fields", () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });

    const result = g.execute("getPet", {
      select: { _tag: true, name: true, meow: true, bark: true },
    });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<{
      _tag: Result.Result<"cat" | "dog", unknown>;
      name: Result.Result<string, unknown>;
      meow: Result.Result<string | undefined, unknown>;
      bark: Result.Result<string | undefined, unknown>;
    }>();
  });

  it("types undefined-nullable object roots as Option.none capable", () => {
    const g = Domain.make({
      getMaybeUser: operation({
        type: Schema.UndefinedOr(User),
        resolve: () => Effect.succeed(undefined),
      }),
    });

    const result = g.execute("getMaybeUser", { select: { id: true } });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<Option.None<never> | { id: Result.Result<string, unknown> }>();
  });

  it("types arrays of undefined-nullable objects as Option.none capable per element", () => {
    const g = Domain.make({
      listMaybeUsers: operation({
        type: Schema.Array(Schema.UndefinedOr(User)),
        resolve: () => Effect.succeed([]),
      }),
    });

    const result = g.execute("listMaybeUsers", { select: { id: true } });
    type R = typeof result extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<R>().toEqualTypeOf<
      Array<Option.None<never> | { id: Result.Result<string, unknown> }>
    >();
  });

  it("fails direct scalar root execution when a concrete select is forced", async () => {
    const g = Domain.make({
      ping: operation({
        type: Schema.String,
        resolve: () => Effect.succeed("pong"),
      }),
    });

    const exit = await Effect.runPromiseExit(
      g.execute("ping", { select: { value: true } } as never),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("types scalar roots as opaque and array roots as element projections", () => {
    type ScalarSelect = RootSelectionFor<number>;
    expectTypeOf<ScalarSelect>().toEqualTypeOf<never>();

    type MixedObjectScalarSelect = RootSelectionFor<{ id: string } | string>;
    expectTypeOf<MixedObjectScalarSelect>().toEqualTypeOf<never>();

    type MixedObjectArraySelect = RootSelectionFor<{ id: string } | Array<{ id: string }>>;
    expectTypeOf<MixedObjectArraySelect>().toEqualTypeOf<never>();

    type ArrayOfMixedObjectArraySelect = RootSelectionFor<
      Array<{ id: string } | Array<{ id: string }>>
    >;
    expectTypeOf<ArrayOfMixedObjectArraySelect>().toEqualTypeOf<never>();

    type ArrayWrappedMixedObjectArraySelect = RootSelectionFor<
      Array<{ id: string } | Array<{ id: string }>> | Array<{ id: string }>
    >;
    expectTypeOf<ArrayWrappedMixedObjectArraySelect>().toEqualTypeOf<never>();

    type ArraySelect = RootSelectionFor<Array<{ id: string; name: string }>>;
    expectTypeOf<keyof ArraySelect>().toEqualTypeOf<"id" | "name">();

    type NestedArraySelect = RootSelectionFor<Array<Array<{ id: string; name: string }>>>;
    expectTypeOf<keyof NestedArraySelect>().toEqualTypeOf<"id" | "name">();

    type ScalarConfigRejectsSelect =
      { readonly select: { readonly value: true } } extends Domain.ExecuteConfig<
        number,
        undefined,
        never
      >
        ? false
        : true;
    const rejectsSelect: ScalarConfigRejectsSelect = true;
    void rejectsSelect;

    type MixedObjectArrayConfigRejectsSelect =
      { readonly select: { readonly id: true } } extends Domain.ExecuteConfig<
        { id: string } | Array<{ id: string }>,
        undefined,
        never
      >
        ? false
        : true;
    const mixedObjectArrayRejectsSelect: MixedObjectArrayConfigRejectsSelect = true;
    void mixedObjectArrayRejectsSelect;

    type ArrayWrappedMixedObjectArrayConfigRejectsSelect =
      { readonly select: { readonly id: true } } extends Domain.ExecuteConfig<
        Array<{ id: string } | Array<{ id: string }>> | Array<{ id: string }>,
        undefined,
        never
      >
        ? false
        : true;
    const arrayWrappedMixedObjectArrayRejectsSelect: ArrayWrappedMixedObjectArrayConfigRejectsSelect = true;
    void arrayWrappedMixedObjectArrayRejectsSelect;

    const scalarGraph = Domain.make({
      countUsers: operation({
        type: Schema.Number,
        resolve: () => Effect.succeed(1),
      }),
    });
    const scalarResult = scalarGraph.execute("countUsers", {});
    type ScalarResult = typeof scalarResult extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<ScalarResult>().toEqualTypeOf<number>();

    const arrayGraph = Domain.make({
      listUsers: operation({
        type: Schema.Array(User),
        resolve: () => Effect.succeed([]),
      }),
    });
    const arrayResult = arrayGraph.execute("listUsers", { select: { id: true } });
    type ArrayResult = typeof arrayResult extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<ArrayResult>().toEqualTypeOf<Array<{ id: Result.Result<string, unknown> }>>();

    const nestedArrayGraph = Domain.make({
      listUserGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([]),
      }),
    });
    const nestedArrayResult = nestedArrayGraph.execute("listUserGroups", { select: { id: true } });
    type NestedArrayResult =
      typeof nestedArrayResult extends Effect.Effect<infer A, any, any> ? A : never;
    expectTypeOf<NestedArrayResult>().toEqualTypeOf<
      Array<Array<{ id: Result.Result<string, unknown> }>>
    >();
  });
});
