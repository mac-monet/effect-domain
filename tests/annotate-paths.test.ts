import { Effect, Option, Result, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { Domain, annotatePaths, node, operation } from "../src/index.ts";

type GeneratedTree = {
  readonly value: unknown;
  readonly paths: ReadonlyArray<ReadonlyArray<string | number>>;
};

function prefixPath(prefix: string | number, path: ReadonlyArray<string | number>) {
  return [prefix, ...path];
}

const generatedTree: fc.Arbitrary<GeneratedTree> = fc.letrec((tie) => {
  const child = tie("child") as fc.Arbitrary<GeneratedTree>;
  const tree = tie("tree") as fc.Arbitrary<GeneratedTree>;

  return {
    tree: fc.oneof(
      fc.constant({ value: Option.none(), paths: [] }),
      fc.string().map((message) => ({
        value: Result.fail(new Error(message)),
        paths: [[]],
      })),
      child.map((generated) => ({
        value: Result.succeed(generated.value),
        paths: [[], ...generated.paths],
      })),
      fc.array(child, { maxLength: 4 }).map((children) => ({
        value: children.map((generated) => generated.value),
        paths: children.flatMap((generated, index) =>
          generated.paths.map((path) => prefixPath(index, path)),
        ),
      })),
      fc
        .uniqueArray(fc.tuple(fc.constantFrom("a", "b", "c", "d"), child), {
          maxLength: 4,
          selector: ([key]) => key,
        })
        .map((entries) => {
          const value: Record<string, unknown> = {};
          const paths: Array<ReadonlyArray<string | number>> = [];
          for (const [key, generated] of entries) {
            value[key] = generated.value;
            paths.push(...generated.paths.map((path) => prefixPath(key, path)));
          }
          return { value, paths };
        }),
    ),
    child: fc.oneof(
      { depthSize: "small", maxDepth: 4 },
      fc.constant({ value: Option.none(), paths: [] }),
      fc.string().map((message) => ({
        value: Result.fail(new Error(message)),
        paths: [[]],
      })),
      tree,
    ),
  };
}).tree;

function pathKey(path: ReadonlyArray<string | number>): string {
  return JSON.stringify(path);
}

describe("Unit 8: annotatePaths()", () => {
  it("flattens a flat result tree into entries with paths", () => {
    const tree = {
      id: Result.succeed("1"),
      name: Result.succeed("Alice"),
    };

    const entries = annotatePaths(tree);
    const byPath = new Map(entries.map((e) => [JSON.stringify(e.path), e.result]));
    expect(Result.getOrThrow(byPath.get('["id"]')!)).toBe("1");
    expect(Result.getOrThrow(byPath.get('["name"]')!)).toBe("Alice");
  });

  it("recurses into nested object successes with composite paths", () => {
    const tree = {
      user: Result.succeed({
        id: Result.succeed("1"),
        name: Result.succeed("Alice"),
      }),
    };

    const entries = annotatePaths(tree);
    const paths = entries.map((e) => e.path);
    expect(paths).toContainEqual(["user"]);
    expect(paths).toContainEqual(["user", "id"]);
    expect(paths).toContainEqual(["user", "name"]);
  });

  it("uses numeric indices for arrays of nested results", () => {
    const tree = {
      users: Result.succeed([
        { id: Result.succeed("1"), name: Result.succeed("Alice") },
        { id: Result.succeed("2"), name: Result.succeed("Bob") },
      ]),
    };

    const entries = annotatePaths(tree);
    const paths = entries.map((e) => e.path);
    expect(paths).toContainEqual(["users", 0, "id"]);
    expect(paths).toContainEqual(["users", 0, "name"]);
    expect(paths).toContainEqual(["users", 1, "id"]);
    expect(paths).toContainEqual(["users", 1, "name"]);
  });

  it("emits failure entries at the path where they occur", () => {
    const tree = {
      ok: Result.succeed("good"),
      bad: Result.fail(new Error("nope")),
    };

    const entries = annotatePaths(tree);
    const failures = entries.filter((e) => Result.isFailure(e.result));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.path).toEqual(["bad"]);
  });

  it("does not recurse into Option.None success values", () => {
    const tree = {
      maybeUser: Result.succeed(Option.none()),
    };

    const entries = annotatePaths(tree);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toEqual(["maybeUser"]);
  });

  it("integrates with execute() output", async () => {
    const User = node(
      "User",
      Schema.Struct({ id: Schema.String, firstName: Schema.String }),
      (f) => ({
        greeting: f.field({
          type: Schema.String,
          resolve: ({ parent }) => Effect.succeed(`Hi ${parent.firstName}`),
        }),
      }),
    );

    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "Alice" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getUser", { select: { id: true, greeting: true } }),
    );

    const entries = annotatePaths(result);
    const paths = entries.map((e) => e.path);
    expect(paths).toContainEqual(["id"]);
    expect(paths).toContainEqual(["greeting"]);
  });

  it("property: emits exactly the generated Result paths", () => {
    fc.assert(
      fc.property(generatedTree, (tree) => {
        const actual = annotatePaths(tree.value).map((entry) => entry.path);
        expect(new Set(actual.map(pathKey))).toEqual(new Set(tree.paths.map(pathKey)));
      }),
      { numRuns: 200 },
    );
  });
});
