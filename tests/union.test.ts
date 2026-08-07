import { Effect, Schema, SchemaAST } from "effect";
import { concreteUnionMember } from "../src/schema/sentinels.ts";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

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

describe("Unit 3: unions and sentinel discrimination", () => {
  it("resolves correct computed fields for a tagged union variant", async () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });

    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({
        name: "getOwner",
        select: { pet: { select: { _tag: true, name: true, meow: true } } },
      }),
    );

    expect(result.pet).toEqual({ _tag: "cat", name: "Whiskers", meow: "Whiskers says meow" });
  });

  it("resolves the other variant correctly", async () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getOwner", select: { pet: { select: { _tag: true, bark: true } } } }),
    );

    expect(result.pet).toEqual({ _tag: "dog", bark: "Rex says woof" });
  });

  it("works with non-_tag discriminator key", async () => {
    const Circle = node(
      "Circle",
      Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Number }),
      {
        area: field({
          type: Schema.Number,
          resolve: ({ parent }) => Effect.succeed(Math.PI * parent.radius ** 2),
        }),
      },
    );

    const Square = node(
      "Square",
      Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Number }),
      {
        area: field({
          type: Schema.Number,
          resolve: ({ parent }) => Effect.succeed(parent.side ** 2),
        }),
      },
    );

    const Shape = Schema.Union([Circle, Square]);

    const Canvas = node("Canvas", Schema.Struct({ id: Schema.String }), {
      shape: field({
        type: Shape,
        resolve: () => Effect.succeed({ kind: "circle" as const, radius: 5 }),
      }),
    });

    const g = Domain.make({
      getCanvas: operation({
        type: Canvas,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getCanvas", select: { shape: { select: { kind: true, area: true } } } }),
    );

    const shape = result.shape as { kind: string; area: number };
    expect(shape.kind).toBe("circle");
    expect(shape.area).toBeCloseTo(Math.PI * 25);
  });

  it("handles union in data field (not computed)", async () => {
    const WithUnionData = node("WithUnionData", Schema.Struct({ id: Schema.String, pet: Pet }), {});

    const g = Domain.make({
      get: operation({
        type: WithUnionData,
        resolve: () => Effect.succeed({ id: "1", pet: { _tag: "dog" as const, name: "Buddy" } }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({
        name: "get",
        select: { pet: { select: { _tag: true, name: true, bark: true } } },
      }),
    );

    expect(result.pet).toEqual({ _tag: "dog", name: "Buddy", bark: "Buddy says woof" });
  });

  it("handles array of union items", async () => {
    const PetOwner = node("PetOwner", Schema.Struct({ id: Schema.String }), {
      pets: field({
        type: Schema.Array(Pet),
        resolve: () =>
          Effect.succeed([
            { _tag: "cat" as const, name: "Whiskers" },
            { _tag: "dog" as const, name: "Rex" },
          ]),
      }),
    });

    const g = Domain.make({
      getOwner: operation({
        type: PetOwner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getOwner", select: { pets: { select: { _tag: true, name: true } } } }),
    );

    expect(result.pets).toEqual([
      { _tag: "cat", name: "Whiskers" },
      { _tag: "dog", name: "Rex" },
    ]);
  });

  it("projects array-wrapped union roots", async () => {
    const g = Domain.make({
      listPets: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        args: Schema.Struct({
          variant: Schema.Union([Schema.Literal("cat"), Schema.Literal("dog")]),
        }),
        resolve: ({ args }) =>
          Effect.succeed(
            args.variant === "cat"
              ? [{ _tag: "cat" as const, name: "Whiskers" }]
              : [{ _tag: "dog" as const, name: "Rex" }],
          ),
      }),
    });

    const catRows = await Effect.runPromise(
      g.execute({
        name: "listPets",
        args: { variant: "cat" },
        select: { _tag: true, name: true, meow: true, bark: true },
      }),
    );
    const dogRows = await Effect.runPromise(
      g.execute({
        name: "listPets",
        args: { variant: "dog" },
        select: { _tag: true, name: true, meow: true, bark: true },
      }),
    );

    expect(catRows[0]!.meow).toBe("Whiskers says meow");
    expect(catRows[0]!.bark).toBeUndefined();
    expect(dogRows[0]!.meow).toBeUndefined();
    expect(dogRows[0]!.bark).toBe("Rex says woof");
  });

  it("NullOr with non-null value walks through union discrimination", async () => {
    const Profile = node("NullOrProfile", Schema.Struct({ bio: Schema.String }), {
      upper: field({
        type: Schema.String,
        resolve: ({ parent }) => Effect.succeed(parent.bio.toUpperCase()),
      }),
    });

    const UserNullable = node("UserNullable", Schema.Struct({ id: Schema.String }), {
      profile: field({
        type: Schema.NullOr(Profile),
        resolve: () => Effect.succeed({ bio: "hello" }),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: UserNullable,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { profile: { select: { bio: true, upper: true } } } }),
    );

    expect(result.profile).toEqual({ bio: "hello", upper: "HELLO" });
  });
});

describe("Union as operation type", () => {
  it("resolves variant computed fields when operation type is a union", async () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getPet", select: { _tag: true, name: true, meow: true } }),
    );

    expect(result._tag).toBe("cat");
    expect(result.name).toBe("Whiskers");
    expect((result as any).meow).toBe("Whiskers says meow");
  });

  it("resolves the other variant when operation type is a union", async () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getPet", select: { _tag: true, name: true, bark: true } }),
    );

    expect(result._tag).toBe("dog");
    expect((result as any).bark).toBe("Rex says woof");
  });

  it("fails loudly when value matches no union variant at the operation root", async () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () =>
          Effect.succeed({ _tag: "fish", name: "Nemo" } as unknown as {
            _tag: "cat";
            name: string;
          }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      g.execute({ name: "getPet", select: { _tag: true, name: true } }),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("fails loudly when a union-typed field returns an unmatched value", async () => {
    const Owner = node("BadOwner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Pet,
        resolve: () =>
          Effect.succeed({ _tag: "fish", name: "Nemo" } as unknown as {
            _tag: "cat";
            name: string;
          }),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const exit = await Effect.runPromiseExit(
      g.execute({ name: "get", select: { pet: { select: { _tag: true } } } }),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("resolves variant computed fields when union is wrapped in NullOr", async () => {
    const Owner = node("NullableOwner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Schema.NullOr(Pet),
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { pet: { select: { _tag: true, meow: true } } } }),
    );

    expect(result.pet).toEqual({ _tag: "cat", meow: "Whiskers says meow" });
  });

  it("resolves variant computed fields when union is wrapped in Suspend", async () => {
    const SuspendedPet = Schema.suspend(() => Pet);

    const Owner = node("SuspendedOwner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: SuspendedPet,
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const g = Domain.make({
      get: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "get", select: { pet: { select: { _tag: true, bark: true } } } }),
    );

    expect(result.pet).toEqual({ _tag: "dog", bark: "Rex says woof" });
  });

  it("resolves variant computed fields for each item in array of unions", async () => {
    const PetOwner = node("ArrayPetOwner", Schema.Struct({ id: Schema.String }), {
      pets: field({
        type: Schema.Array(Pet),
        resolve: () =>
          Effect.succeed([
            { _tag: "cat" as const, name: "Whiskers" },
            { _tag: "dog" as const, name: "Rex" },
          ]),
      }),
    });

    const g = Domain.make({
      getOwner: operation({
        type: PetOwner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({
        name: "getOwner",
        select: { pets: { select: { _tag: true, name: true, meow: true, bark: true } } },
      }),
    );

    const pets = result.pets as Array<Record<string, unknown>>;
    expect(pets[0]!._tag).toBe("cat");
    expect(pets[0]!.meow).toBe("Whiskers says meow");
    expect(pets[0]!.bark).toBeUndefined();
    expect(pets[1]!._tag).toBe("dog");
    expect(pets[1]!.bark).toBe("Rex says woof");
    expect(pets[1]!.meow).toBeUndefined();
  });
});

describe("Schema.Class union members", () => {
  class Circle extends Schema.TaggedClass<Circle>()("circle", { radius: Schema.Number }) {}
  class Square extends Schema.TaggedClass<Square>()("square", { side: Schema.Number }) {}

  it("discriminates class-based variants via declaration sentinels", async () => {
    const Owner = node("ShapeOwner", Schema.Struct({ id: Schema.String }), {
      shape: field({
        type: Schema.Union([Circle, Square]),
        resolve: () => Effect.succeed(new Square({ side: 4 })),
      }),
    });

    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute({ name: "getOwner", select: { shape: { select: { _tag: true, side: true } } } }),
    );

    expect(result.shape).toEqual({ _tag: "square", side: 4 });
  });

  it("collects declaration sentinels so the matched member is exact, not first-wins", () => {
    // Type-side Schema.Class members are Declarations carrying `~sentinels`
    // annotations; without the Declaration case in collectSentinels both
    // variants fall into the runtime-type bucket and the first one wins.
    const union = SchemaAST.toType(Schema.Union([Circle, Square]).ast) as SchemaAST.Union;
    const matched = concreteUnionMember(new Square({ side: 4 }), union);
    expect(matched).toBe(union.types[1]);
    expect(concreteUnionMember(new Circle({ radius: 2 }), union)).toBe(union.types[0]);
  });
});

describe("sentinel edge cases", () => {
  function typeUnion(schema: Schema.Top): SchemaAST.Union {
    const typeAst = SchemaAST.toType(schema.ast);
    if (!SchemaAST.isUnion(typeAst)) throw new Error("expected a union");
    return typeAst;
  }

  it("discriminates by number literal sentinels", () => {
    const One = Schema.Struct({ version: Schema.Literal(1), a: Schema.String });
    const Two = Schema.Struct({ version: Schema.Literal(2), b: Schema.String });
    const union = typeUnion(Schema.Union([One, Two]));
    expect(concreteUnionMember({ version: 2, b: "x" }, union)).toBe(union.types[1]);
    expect(concreteUnionMember({ version: 1, a: "x" }, union)).toBe(union.types[0]);
  });

  it("discriminates by boolean literal sentinels", () => {
    const Yes = Schema.Struct({ ok: Schema.Literal(true), value: Schema.String });
    const No = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });
    const union = typeUnion(Schema.Union([Yes, No]));
    expect(concreteUnionMember({ ok: false, error: "boom" }, union)).toBe(union.types[1]);
    expect(concreteUnionMember({ ok: true, value: "fine" }, union)).toBe(union.types[0]);
  });

  it("discriminates by unique symbol sentinels", () => {
    const catSym = Symbol.for("effect-domain/test/cat");
    const dogSym = Symbol.for("effect-domain/test/dog");
    const SymCat = Schema.Struct({ tag: Schema.UniqueSymbol(catSym), name: Schema.String });
    const SymDog = Schema.Struct({ tag: Schema.UniqueSymbol(dogSym), name: Schema.String });
    const union = typeUnion(Schema.Union([SymCat, SymDog]));
    expect(concreteUnionMember({ tag: dogSym, name: "Rex" }, union)).toBe(union.types[1]);
  });

  it("first declared member wins for duplicate sentinel values", () => {
    const A = Schema.Struct({ _tag: Schema.Literal("same"), a: Schema.String });
    const B = Schema.Struct({ _tag: Schema.Literal("same"), b: Schema.String });
    const union = typeUnion(Schema.Union([A, B]));
    // Documented behavior (matches upstream candidate ordering): ambiguity is
    // resolved silently in declaration order.
    expect(concreteUnionMember({ _tag: "same", b: "x" }, union)).toBe(union.types[0]);
  });

  it("returns undefined when no member matches the runtime value", () => {
    const union = typeUnion(Schema.Union([Cat, Dog]));
    expect(concreteUnionMember({ _tag: "fish", name: "Bubbles" }, union)).toBeUndefined();
    expect(concreteUnionMember(42, union)).toBeUndefined();
  });

  it("resolves single-member unions", () => {
    const union = typeUnion(Schema.Union([Cat]));
    expect(concreteUnionMember({ _tag: "cat", name: "Mia" }, union)).toBe(union.types[0]);
  });
});
