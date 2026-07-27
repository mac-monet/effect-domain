import { Cause, Effect, Exit, Option, Result, Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";
import { rootPlan } from "../src/selection/projection.ts";
import { unwrapType } from "../src/schema/ast.ts";
import type { Selection } from "../src/index.ts";

const User = node(
  "RootPlanUser",
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
  "RootPlanCat",
  Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }),
  {},
);
const Dog = node(
  "RootPlanDog",
  Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
  {},
);

function decode(schema: unknown, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
}

async function expectDies(effect: Effect.Effect<unknown, never, never>): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
  }
}

describe("rootPlan classification", () => {
  it("classifies object roots with identical walk/schema targets", () => {
    const plan = rootPlan(User.ast);
    expect(plan._tag).toBe("ObjectRoot");
    if (plan._tag !== "ObjectRoot") return;
    expect(plan.nullable).toBe(false);
    expect(plan.walkTarget).toBe(plan.schemaTarget);
    expect(SchemaAST.isObjects(plan.walkTarget)).toBe(true);
  });

  it("classifies nullable object roots keeping the union for walking", () => {
    const plan = rootPlan(Schema.NullOr(User).ast);
    expect(plan._tag).toBe("ObjectRoot");
    if (plan._tag !== "ObjectRoot") return;
    expect(plan.nullable).toBe(true);
    expect(SchemaAST.isUnion(plan.walkTarget)).toBe(true);
    expect(SchemaAST.isObjects(plan.schemaTarget)).toBe(true);
  });

  it("classifies object-only union roots", () => {
    const plan = rootPlan(Schema.Union([Cat, Dog]).ast);
    expect(plan._tag).toBe("ObjectRoot");
    if (plan._tag !== "ObjectRoot") return;
    expect(plan.nullable).toBe(false);
    expect(SchemaAST.isUnion(plan.walkTarget)).toBe(true);
    expect(SchemaAST.isUnion(plan.schemaTarget)).toBe(true);
  });

  it("classifies array object roots", () => {
    const plan = rootPlan(Schema.Array(User).ast);
    expect(plan._tag).toBe("ArrayRoot");
    if (plan._tag !== "ArrayRoot") return;
    expect(plan.nullable).toBe(false);
    expect(SchemaAST.isObjects(unwrapType(plan.element))).toBe(true);
    expect(SchemaAST.isObjects(plan.selectionTarget)).toBe(true);
  });

  it("classifies nullable array roots by unwrapping the union", () => {
    const plan = rootPlan(Schema.NullOr(Schema.Array(User)).ast);
    expect(plan._tag).toBe("ArrayRoot");
    if (plan._tag !== "ArrayRoot") return;
    expect(plan.nullable).toBe(true);
    expect(SchemaAST.isObjects(unwrapType(plan.element))).toBe(true);
  });

  it("classifies nullable nested array roots with the outer level unwrapped once", () => {
    const plan = rootPlan(Schema.NullOr(Schema.Array(Schema.Array(User))).ast);
    expect(plan._tag).toBe("ArrayRoot");
    if (plan._tag !== "ArrayRoot") return;
    expect(plan.nullable).toBe(true);
    expect(SchemaAST.isArrays(unwrapType(plan.element))).toBe(true);
    expect(SchemaAST.isObjects(plan.selectionTarget)).toBe(true);
  });

  it("classifies multi-variant array-wrapped union roots with a synthesized union element", () => {
    const plan = rootPlan(Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]).ast);
    expect(plan._tag).toBe("ArrayRoot");
    if (plan._tag !== "ArrayRoot") return;
    expect(SchemaAST.isUnion(unwrapType(plan.element))).toBe(true);
  });

  it("classifies scalar roots as opaque", () => {
    const plan = rootPlan(Schema.String.ast);
    expect(plan).toMatchObject({ _tag: "OpaqueRoot", nullable: false, mustBeArray: false });
  });

  it("classifies scalar array roots as opaque with the array-shape check preserved", () => {
    const plan = rootPlan(Schema.Array(Schema.String).ast);
    expect(plan).toMatchObject({ _tag: "OpaqueRoot", nullable: false, mustBeArray: true });
  });

  it("classifies empty-rest tuple roots as opaque arrays", () => {
    const plan = rootPlan(Schema.Tuple([Schema.String]).ast);
    expect(plan).toMatchObject({ _tag: "OpaqueRoot", mustBeArray: true });
  });

  it("classifies nullable scalar roots as opaque with a non-nullish codec AST", () => {
    const plan = rootPlan(Schema.NullOr(Schema.String).ast);
    expect(plan).toMatchObject({
      _tag: "OpaqueRoot",
      nullable: true,
      reason: "scalar-only union root",
    });
    if (plan._tag !== "OpaqueRoot") return;
    expect(SchemaAST.isUnion(plan.codecAst)).toBe(false);
  });

  it("classifies mixed object/scalar union roots as opaque with a reason", () => {
    const plan = rootPlan(Schema.Union([User, Schema.String]).ast);
    expect(plan).toMatchObject({ _tag: "OpaqueRoot", reason: "mixed object/scalar union root" });
  });

  it("classifies mixed collection union roots as opaque with a reason", () => {
    const plan = rootPlan(Schema.Union([User, Schema.Array(User)]).ast);
    expect(plan).toMatchObject({ _tag: "OpaqueRoot", reason: "mixed collection union root" });
  });

  it("classifies nullish roots as opaque and nullable", () => {
    const plan = rootPlan(Schema.Null.ast);
    expect(plan).toMatchObject({
      _tag: "OpaqueRoot",
      nullable: true,
      reason: "null-or-scalar root",
    });
  });

  it("classifies suspend-wrapped object roots by unwrapping the suspend", () => {
    const plan = rootPlan(Schema.suspend(() => User).ast);
    expect(plan._tag).toBe("ObjectRoot");
    if (plan._tag !== "ObjectRoot") return;
    expect(SchemaAST.isObjects(plan.walkTarget)).toBe(true);
  });

  it("caches plans per AST identity, keeping synthesized ASTs stable across calls", () => {
    const ast = Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]).ast;
    const first = rootPlan(ast);
    const second = rootPlan(ast);
    expect(second).toBe(first);
    if (first._tag !== "ArrayRoot" || second._tag !== "ArrayRoot") return;
    // The synthesized element union must be built once — downstream WeakMap
    // caches key on its identity.
    expect(second.element).toBe(first.element);
  });
});

describe("root plan interpreter agreement", () => {
  const nullableList = Domain.make({
    maybeUsers: operation({
      type: Schema.NullOr(Schema.Array(User)),
      args: Schema.Struct({ empty: Schema.Boolean }),
      resolve: ({ args }) =>
        Effect.succeed(args.empty ? null : [{ id: "1", firstName: "Alice", lastName: "Smith" }]),
    }),
  });

  it("walker projects nullable array roots and maps null to Option.none", async () => {
    const projected = await Effect.runPromise(
      nullableList.execute("maybeUsers", {
        args: { empty: false },
        select: { id: true, fullName: true },
      }),
    );
    const rows = projected as ReadonlyArray<Record<string, Result.Result<string, unknown>>>;
    expect(Result.getOrThrow(rows[0]!.fullName)).toBe("Alice Smith");

    const absent = await Effect.runPromise(
      nullableList.execute("maybeUsers", { args: { empty: true }, select: { id: true } }),
    );
    expect(Option.isNone(absent as Option.Option<never>)).toBe(true);
  });

  it("selectionSchema accepts element selections for nullable array roots", () => {
    const schema = nullableList.selectionSchema("maybeUsers");
    expect(decode(schema, { id: true, fullName: true })).toEqual({ id: true, fullName: true });
    expect(decode(schema, undefined)).toBeUndefined();
    expect(() => decode(schema, { unknownField: true })).toThrow();
  });

  it("responseSchema wraps nullable array roots in a none-or-value codec", () => {
    const selection = decode(nullableList.selectionSchema("maybeUsers"), { id: true });
    const schema = nullableList.responseSchema("maybeUsers", selection as Selection);

    expect(Option.isNone(decode(schema, { _tag: "None" }) as Option.Option<never>)).toBe(true);
    const rows = decode(schema, [{ id: { _tag: "Success", success: "1" } }]) as ReadonlyArray<
      Record<string, Result.Result<string, unknown>>
    >;
    expect(Result.getOrThrow(rows[0]!.id)).toBe("1");
  });

  const opaqueList = Domain.make({
    listIds: operation({
      type: Schema.Array(Schema.String),
      resolve: () => Effect.succeed(["1", "2"] as never),
    }),
    brokenListIds: operation({
      type: Schema.Array(Schema.String),
      resolve: () => Effect.succeed("not-an-array" as never),
    }),
  });

  it("walker still enforces the array-shape defect for opaque array roots", async () => {
    expect(await Effect.runPromise(opaqueList.execute("listIds", {}))).toEqual(["1", "2"]);
    await expectDies(opaqueList.execute("brokenListIds", {}));
  });

  it("all three interpreters reject selections on opaque array roots", async () => {
    await expectDies(opaqueList.execute("listIds", { select: { id: true } } as never));
    expect(() => decode(opaqueList.selectionSchema("listIds"), { id: true })).toThrow(
      /opaque root does not accept a selection/,
    );
    expect(() => opaqueList.responseSchema("listIds", { id: true } as never)).toThrow(
      /opaque root does not accept a selection/,
    );
  });

  const mixedUnion = Domain.make({
    userOrCount: operation({
      type: Schema.Union([User, Schema.Number]),
      resolve: () => Effect.succeed(7),
    }),
  });

  it("all three interpreters treat mixed object/scalar union roots as opaque", async () => {
    expect(await Effect.runPromise(mixedUnion.execute("userOrCount", {}))).toBe(7);
    await expectDies(mixedUnion.execute("userOrCount", { select: { id: true } } as never));
    expect(() => decode(mixedUnion.selectionSchema("userOrCount"), { id: true })).toThrow(
      /mixed object\/scalar union root/,
    );
    expect(() => mixedUnion.responseSchema("userOrCount", { id: true } as never)).toThrow(
      /mixed object\/scalar union root/,
    );
  });

  const nullableScalar = Domain.make({
    maybeCount: operation({
      type: Schema.NullOr(Schema.Number),
      args: Schema.Struct({ empty: Schema.Boolean }),
      resolve: ({ args }) => Effect.succeed(args.empty ? null : 3),
    }),
  });

  it("walker maps null to Option.none on nullable opaque roots and passes values through", async () => {
    expect(
      await Effect.runPromise(nullableScalar.execute("maybeCount", { args: { empty: false } })),
    ).toBe(3);
    const absent = await Effect.runPromise(
      nullableScalar.execute("maybeCount", { args: { empty: true } }),
    );
    expect(Option.isNone(absent as Option.Option<never>)).toBe(true);
  });

  it("responseSchema derives none-or-value codecs for nullable opaque roots", () => {
    const schema = nullableScalar.responseSchema("maybeCount", undefined as never);
    expect(Option.isNone(decode(schema, { _tag: "None" }) as Option.Option<never>)).toBe(true);
    expect(decode(schema, 3)).toBe(3);
  });

  it("walker rejects selections forced onto tuple roots (aligned with the schema interpreters)", async () => {
    const tuples = Domain.make({
      pair: operation({
        type: Schema.Tuple([Schema.String, Schema.Number]),
        resolve: () => Effect.succeed(["a", 1] as const),
      }),
    });
    expect(await Effect.runPromise(tuples.execute("pair", {} as never))).toEqual(["a", 1]);
    await expectDies(tuples.execute("pair", { select: { id: true } } as never));
    expect(() => decode(tuples.selectionSchema("pair"), { id: true })).toThrow();
    expect(() => tuples.responseSchema("pair", { id: true } as never)).toThrow(
      /opaque root does not accept a selection/,
    );
  });

  it("all three interpreters agree on nullable object-only union roots", async () => {
    const maybePet = Domain.make({
      maybePet: operation({
        type: Schema.NullOr(Schema.Union([Cat, Dog])),
        args: Schema.Struct({ empty: Schema.Boolean }),
        resolve: ({ args }) =>
          Effect.succeed(args.empty ? null : { _tag: "cat" as const, name: "Mia" }),
      }),
    });

    const projected = (await Effect.runPromise(
      maybePet.execute("maybePet", { args: { empty: false }, select: { name: true } }),
    )) as Record<string, Result.Result<string, unknown>>;
    expect(Result.getOrThrow(projected.name!)).toBe("Mia");

    const absent = await Effect.runPromise(
      maybePet.execute("maybePet", { args: { empty: true }, select: { name: true } }),
    );
    expect(Option.isNone(absent as Option.Option<never>)).toBe(true);

    expect(decode(maybePet.selectionSchema("maybePet"), { name: true })).toEqual({ name: true });

    const schema = maybePet.responseSchema("maybePet", { name: true } as never);
    expect(Option.isNone(decode(schema, { _tag: "None" }) as Option.Option<never>)).toBe(true);
    const decoded = decode(schema, { name: { _tag: "Success", success: "Mia" } }) as Record<
      string,
      Result.Result<string, unknown>
    >;
    expect(Result.getOrThrow(decoded.name!)).toBe("Mia");
  });

  it("walker projects multi-variant array-wrapped union roots per element", async () => {
    const pets = Domain.make({
      listPets: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        resolve: () => Effect.succeed([{ _tag: "cat" as const, name: "Mia" }]),
      }),
    });
    const rows = (await Effect.runPromise(
      pets.execute("listPets", { select: { name: true } } as never),
    )) as unknown as ReadonlyArray<Record<string, Result.Result<string, unknown>>>;
    expect(Result.getOrThrow(rows[0]!.name)).toBe("Mia");

    expect(decode(pets.selectionSchema("listPets"), { name: true })).toEqual({ name: true });

    const schema = pets.responseSchema("listPets", { name: true } as never);
    const decoded = decode(schema, [
      { name: { _tag: "Success", success: "Mia" } },
    ]) as ReadonlyArray<Record<string, Result.Result<string, unknown>>>;
    expect(Result.getOrThrow(decoded[0]!.name)).toBe("Mia");
  });
});
