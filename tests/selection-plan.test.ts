import { Effect, Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { field, node } from "../src/index.ts";
import {
  planRuntimeFields,
  planRuntimeNode,
  planSelectedFields,
  planSelectedNode,
} from "../src/selection/plan.ts";
import { buildRegistry } from "../src/registry.ts";

// Empty registry: these tests exercise the raw-AST fallback path.
const registry = buildRegistry({});

const Cat = node("PlanCat", Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }), {
  sound: field({
    type: Schema.String,
    resolve: () => Effect.succeed("meow"),
  }),
});

const Dog = node("PlanDog", Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }), {
  bark: field({
    type: Schema.String,
    resolve: () => Effect.succeed("woof"),
  }),
});

describe("planSelectedFields", () => {
  it("wraps selected fields in an explicit node traversal plan", () => {
    const plan = planSelectedNode(registry, Cat.ast, { name: true, sound: true });

    expect(plan.ast).toBe(Cat.ast);
    expect(plan.fields.map((field) => field.entry.fieldName)).toEqual(["name", "sound"]);
  });

  it("classifies computed and data fields from one selected field boundary", () => {
    const fields = planSelectedFields(registry, Cat.ast, { name: true, sound: true });

    expect(fields.map((field) => field.entry.fieldName)).toEqual(["name", "sound"]);
    expect(fields[0]?.fieldDef).toBeUndefined();
    expect(fields[0]?.fieldAsts).toHaveLength(1);
    expect(fields[1]?.fieldDef?._kind).toBe("computed");
    expect(fields[1]?.fieldAsts).toHaveLength(1);
  });

  it("adds undefined fallback for fields present on only some object-union variants", () => {
    const fields = planSelectedFields(registry, Schema.Union([Cat, Dog]).ast, {
      name: true,
      sound: true,
    });

    const shared = fields.find((field) => field.entry.fieldName === "name");
    const variantOnly = fields.find((field) => field.entry.fieldName === "sound");

    expect(shared?.fieldAsts).toHaveLength(2);
    expect(variantOnly?.fieldAsts).toHaveLength(2);
    expect(variantOnly?.fieldAsts.some(SchemaAST.isUndefined)).toBe(true);
  });

  it("plans runtime union members as resolve or missing-on-variant actions", () => {
    const fields = planRuntimeFields(registry, Schema.Union([Cat, Dog]).ast, Dog.ast, {
      name: true,
      sound: true,
      bark: true,
    });

    expect(fields.map((field) => [field.entry.fieldName, field._tag])).toEqual([
      ["name", "Resolve"],
      ["sound", "MissingOnVariant"],
      ["bark", "Resolve"],
    ]);
    const bark = fields.find((field) => field.entry.fieldName === "bark");
    expect(bark?._tag).toBe("Resolve");
    expect(bark?._tag === "Resolve" ? bark.fieldDef?._kind : undefined).toBe("computed");
  });

  it("wraps runtime union fields in an explicit node traversal plan", () => {
    const plan = planRuntimeNode(registry, Schema.Union([Cat, Dog]).ast, Dog.ast, {
      name: true,
      sound: true,
    });

    expect(plan.memberAst).toBe(Dog.ast);
    expect(plan.fields.map((field) => [field.entry.fieldName, field._tag])).toEqual([
      ["name", "Resolve"],
      ["sound", "MissingOnVariant"],
    ]);
  });
});

describe("plan caching", () => {
  it("returns the identical plan for the same (ast, selection) pair", () => {
    const selection = { name: true, sound: true } as const;
    const first = planSelectedNode(registry, Cat.ast, selection);
    const second = planSelectedNode(registry, Cat.ast, selection);
    expect(second).toBe(first);
  });

  it("builds distinct plans for distinct selection objects", () => {
    const first = planSelectedNode(registry, Cat.ast, { name: true });
    const second = planSelectedNode(registry, Cat.ast, { name: true });
    expect(second).not.toBe(first);
    expect(second.fields.map((field) => field.entry.fieldName)).toEqual(
      first.fields.map((field) => field.entry.fieldName),
    );
  });

  it("returns the identical runtime plan for the same (union, member, selection) triple", () => {
    const union = Schema.Union([Cat, Dog]).ast;
    const selection = { name: true, bark: true } as const;
    const first = planRuntimeNode(registry, union, Dog.ast, selection);
    const second = planRuntimeNode(registry, union, Dog.ast, selection);
    expect(second).toBe(first);
  });

  it("does not cache plans that fail to parse", () => {
    const selection = { name: [{ alias: "x" }, { alias: "x" }] };
    expect(() => planSelectedNode(registry, Cat.ast, selection)).toThrow(/duplicate output key/);
    expect(() => planSelectedNode(registry, Cat.ast, selection)).toThrow(/duplicate output key/);
  });
});
