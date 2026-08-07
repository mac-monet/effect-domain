import { Context, Effect, Layer, Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Ast, Domain, node, operation, unionDiscriminator } from "../src/index.ts";

// The adapter-facing surface: Ast helpers, unionDiscriminator, Domain.erase.

describe("Ast helpers", () => {
  it("splitNullability splits NullOr into core + nullable", () => {
    const User = Schema.Struct({ id: Schema.String });
    const { core, nullable } = Ast.splitNullability(Schema.NullOr(User).ast);
    expect(nullable).toBe(true);
    expect(SchemaAST.isObjects(core)).toBe(true);
  });

  it("splitNullability keeps a multi-member union as the core", () => {
    const A = Schema.Struct({ _tag: Schema.Literal("A") });
    const B = Schema.Struct({ _tag: Schema.Literal("B") });
    const { core, nullable } = Ast.splitNullability(Schema.NullOr(Schema.Union([A, B])).ast);
    expect(nullable).toBe(true);
    expect(SchemaAST.isUnion(core)).toBe(true);
  });

  it("identifierOf resolves annotations through suspend/type wrappers", () => {
    const User = Schema.Struct({ id: Schema.String }).annotate({ identifier: "User" });
    expect(Ast.identifierOf(User.ast)).toBe("User");
    expect(Ast.identifierOf(Ast.unwrapType(Schema.suspend(() => User).ast))).toBe("User");
  });
});

describe("unionDiscriminator", () => {
  const A = Schema.Struct({ _tag: Schema.Literal("A"), a: Schema.String });
  const B = Schema.Struct({ _tag: Schema.Literal("B"), b: Schema.Number });

  it("finds the common literal key with per-member literals in order", () => {
    const result = unionDiscriminator([A.ast, B.ast]);
    expect(result).toEqual({ key: "_tag", literals: ["A", "B"] });
  });

  it("returns undefined when literals collide", () => {
    const B2 = Schema.Struct({ _tag: Schema.Literal("A"), b: Schema.Number });
    expect(unionDiscriminator([A.ast, B2.ast])).toBeUndefined();
  });

  it("returns undefined when a member lacks the key", () => {
    const NoTag = Schema.Struct({ b: Schema.Number });
    expect(unionDiscriminator([A.ast, NoTag.ast])).toBeUndefined();
  });

  it("rejects a union whose first common key collides, even if a later key differs", () => {
    // The walker dispatches on the FIRST sentinel key a value carries, so
    // `kind: "same"` shadows `sub` — values of Y would misdispatch to X.
    // Reporting `sub` here would codify a discriminator the walker never
    // consults.
    const X = Schema.Struct({ kind: Schema.Literal("same"), sub: Schema.Literal("x") });
    const Y = Schema.Struct({ kind: Schema.Literal("same"), sub: Schema.Literal("y") });
    expect(unionDiscriminator([X.ast, Y.ast])).toBeUndefined();
  });

  it('distinguishes literals by value AND type (1 vs "1")', () => {
    const N = Schema.Struct({ _tag: Schema.Literal(1) });
    const S = Schema.Struct({ _tag: Schema.Literal("1") });
    expect(unionDiscriminator([N.ast, S.ast])).toEqual({ key: "_tag", literals: [1, "1"] });
  });

  it("reads Schema.Class sentinels from the declaration annotation", () => {
    class CA extends Schema.Class<CA>("CA")({ _tag: Schema.Literal("CA"), a: Schema.String }) {}
    class CB extends Schema.Class<CB>("CB")({ _tag: Schema.Literal("CB"), b: Schema.Number }) {}
    const result = unionDiscriminator([CA.ast, CB.ast]);
    expect(result?.key).toBe("_tag");
    expect(result?.literals).toEqual(["CA", "CB"]);
  });
});

describe("Domain.erase", () => {
  const Echo = node("Echo", Schema.Struct({ echo: Schema.String }), {});

  it("erases a service-free graph and executes through the erased surface", async () => {
    const g = Domain.make({
      hello: operation({
        type: Echo,
        args: Schema.Struct({ who: Schema.String }),
        resolve: ({ args }) => Effect.succeed({ echo: `hi ${args.who}` }),
      }),
    });
    const erased = Domain.erase(g);
    expect(erased.inspect().operations.map((op) => op.name)).toEqual(["hello"]);
    expect(SchemaAST.isObjects(SchemaAST.toType(erased.argsSchema("hello").ast))).toBe(true);
    const result = (await Effect.runPromise(
      erased.execute({
        name: "hello",
        args: { who: "world" },
        select: { echo: true },
      }) as Effect.Effect<unknown>,
    )) as { echo: string };
    expect(result.echo).toBe("hi world");
  });

  it("erases a provided graph, and rejects an unprovided one at compile time", async () => {
    class Greeter extends Context.Service<Greeter, { greeting: string }>()("Greeter") {}
    const g = Domain.make({
      greet: operation({
        type: Echo,
        resolve: () =>
          Effect.gen(function* () {
            const { greeting } = yield* Greeter;
            return { echo: greeting };
          }),
      }),
    });
    // @ts-expect-error — Greeter is not provided, erase must not accept it
    Domain.erase(g);
    const erased = Domain.erase(g.provide(Layer.succeed(Greeter)({ greeting: "yo" })));
    const result = (await Effect.runPromise(
      erased.execute({ name: "greet", select: { echo: true } }) as Effect.Effect<unknown>,
    )) as { echo: string };
    expect(result.echo).toBe("yo");
  });
});

describe("declared error schema coverage", () => {
  const Echo = node("CovEcho", Schema.Struct({ echo: Schema.String }), {});
  const Declared = Schema.Struct({ _tag: Schema.Literal("Declared"), why: Schema.String });

  it("accepts resolvers whose failures the declared schema covers", () => {
    const def = operation({
      type: Echo,
      error: Declared,
      resolve: () => Effect.fail({ _tag: "Declared", why: "covered" } as const),
    });
    expect(def._stream).toBe(false);
  });

  it("rejects resolvers failing outside the declared schema at compile time", () => {
    const uncovered = {
      type: Echo,
      error: Declared,
      resolve: () => Effect.fail({ _tag: "Other" } as const),
    };
    // @ts-expect-error — resolver fails with { _tag: "Other" }, not covered by Declared
    operation(uncovered);
    // no declared schema: any E is fine
    const free = operation({
      type: Echo,
      resolve: () => Effect.fail({ _tag: "Whatever" } as const),
    });
    expect(free._stream).toBe(false);
  });
});
