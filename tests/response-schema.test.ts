import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { domain } from "../examples/domain.ts";
import {
  Domain,
  field,
  node,
  operation,
  OperationError,
  type Selection,
  UnknownOperation,
} from "../src/index.ts";

function decode(schema: unknown, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
}

function encode(schema: unknown, value: unknown): unknown {
  return Schema.encodeUnknownSync(schema as Schema.Codec<unknown>)(value);
}

const Profile = node("PropertyProfile", Schema.Struct({ bio: Schema.String }), {
  upperBio: field({
    type: Schema.String,
    resolve: ({ parent }) => Effect.succeed(parent.bio.toUpperCase()),
  }),
});

const Post = node(
  "PropertyPost",
  Schema.Struct({
    title: Schema.String,
    likes: Schema.Number,
  }),
  {},
);

const PropertyUser = node(
  "PropertyUser",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    profile: Profile,
  }),
  {
    greeting: field({
      type: Schema.String,
      args: Schema.Struct({ name: Schema.String }),
      resolve: ({ args }) => Effect.succeed(`Hello ${args.name}`),
    }),
    posts: field({
      type: Schema.Array(Post),
      resolve: () =>
        Effect.succeed([
          { title: "First", likes: 1 },
          { title: "Second", likes: 2 },
        ]),
    }),
  },
);

const propertyGraph = Domain.make({
  getUser: operation({
    type: PropertyUser,
    resolve: () =>
      Effect.succeed({
        id: "u1",
        name: "Ada",
        profile: { bio: "hello" },
      }),
  }),
});

class DispatchBoom extends Schema.TaggedErrorClass<DispatchBoom>()("DispatchBoom", {
  message: Schema.String,
}) {}

const FuzzCat = node(
  "FuzzResponseCat",
  Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }),
  {
    meow: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} meows`),
    }),
  },
);

const FuzzDog = node(
  "FuzzResponseDog",
  Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
  {
    bark: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} barks`),
    }),
  },
);

const FuzzPet = Schema.Union([FuzzCat, FuzzDog]);

const unionGraph = Domain.make({
  getPet: operation({
    type: FuzzPet,
    args: Schema.Struct({ variant: Schema.Union([Schema.Literal("cat"), Schema.Literal("dog")]) }),
    resolve: ({ args }) =>
      Effect.succeed(
        args.variant === "cat"
          ? { _tag: "cat" as const, name: "Whiskers" }
          : { _tag: "dog" as const, name: "Rex" },
      ),
  }),
  listPets: operation({
    type: Schema.Array(FuzzPet),
    resolve: () =>
      Effect.succeed([
        { _tag: "cat" as const, name: "Whiskers" },
        { _tag: "dog" as const, name: "Rex" },
      ]),
  }),
  listPetVariant: operation({
    type: Schema.Union([Schema.Array(FuzzCat), Schema.Array(FuzzDog)]),
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

const scalarFieldSelection = fc.oneof(
  fc.constant(true),
  fc.record({ alias: fc.string({ minLength: 1, maxLength: 8 }) }),
);

function hasUniqueOutputKeys(selection: Record<string, unknown>): boolean {
  const seen = new Set<string>();
  for (const [fieldName, raw] of Object.entries(selection)) {
    if (raw === undefined) return false;
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      const alias =
        entry !== true &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { alias?: unknown }).alias === "string"
          ? (entry as { alias: string }).alias
          : fieldName;
      if (seen.has(alias)) return false;
      seen.add(alias);
      if (
        entry !== true &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { select?: unknown }).select !== undefined &&
        !hasUniqueOutputKeys((entry as { select: Record<string, unknown> }).select)
      ) {
        return false;
      }
    }
  }
  return true;
}

function compactUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, compactUndefined(entry)]),
    );
  }
  return value;
}

const profileSelection = fc
  .record({
    bio: fc.option(scalarFieldSelection, { nil: undefined }),
    upperBio: fc.option(scalarFieldSelection, { nil: undefined }),
  })
  .map((selection) => compactUndefined(selection) as Record<string, unknown>)
  .filter((selection) => Object.keys(selection).length > 0 && hasUniqueOutputKeys(selection));

const postSelection = fc
  .record({
    title: fc.option(scalarFieldSelection, { nil: undefined }),
    likes: fc.option(scalarFieldSelection, { nil: undefined }),
  })
  .map((selection) => compactUndefined(selection) as Record<string, unknown>)
  .filter((selection) => Object.keys(selection).length > 0 && hasUniqueOutputKeys(selection));

const validSelection = fc
  .record({
    id: fc.option(scalarFieldSelection, { nil: undefined }),
    name: fc.option(scalarFieldSelection, { nil: undefined }),
    greeting: fc.option(
      fc.record({
        args: fc.record({ name: fc.string({ minLength: 1, maxLength: 8 }) }),
        alias: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    profile: fc.option(
      profileSelection.map((select) => ({ select })),
      { nil: undefined },
    ),
    posts: fc.option(
      postSelection.map((select) => ({ select })),
      { nil: undefined },
    ),
  })
  .map((selection) => compactUndefined(selection) as Record<string, unknown>)
  .filter((selection) => Object.keys(selection).length > 0 && hasUniqueOutputKeys(selection));

const unionSelection = fc
  .record({
    _tag: fc.option(scalarFieldSelection, { nil: undefined }),
    name: fc.option(scalarFieldSelection, { nil: undefined }),
    meow: fc.option(scalarFieldSelection, { nil: undefined }),
    bark: fc.option(scalarFieldSelection, { nil: undefined }),
  })
  .map((selection) => compactUndefined(selection) as Record<string, unknown>)
  .filter((selection) => Object.keys(selection).length > 0 && hasUniqueOutputKeys(selection));

describe("Domain.responseSchema", () => {
  it("decodes selected object fields as plain data", async () => {
    const selection = decode(domain.selectionSchema("getUser"), {
      id: true,
      fullName: true,
    });
    const schema = domain.responseSchema("getUser", selection as Selection);

    const decoded = decode(schema, {
      id: "1",
      fullName: "Alice Anderson",
    }) as Record<string, string>;

    expect(decoded.id).toBe("1");
    expect(decoded.fullName).toBe("Alice Anderson");
  });

  it("decodes root arrays of objects as plain arrays", () => {
    const selection = decode(domain.selectionSchema("listUsers"), {
      id: true,
      fullName: true,
    });
    const schema = domain.responseSchema("listUsers", selection as Selection);

    const decoded = decode(schema, [{ id: "1", fullName: "Alice Anderson" }]) as ReadonlyArray<
      Record<string, string>
    >;

    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded[0]!.fullName).toBe("Alice Anderson");
  });

  it("returns scalar root schemas directly", () => {
    const g = Domain.make({
      ping: operation({
        type: Schema.String,
        resolve: () => Effect.succeed("pong"),
      }),
    });
    const selection = decode(g.selectionSchema("ping"), undefined);
    const schema = g.responseSchema("ping", selection as undefined);

    expect(decode(schema, "pong")).toBe("pong");
    expect(() => decode(schema, 123)).toThrow();
  });

  it("rejects concrete selections for scalar root response schemas", () => {
    const g = Domain.make({
      ping: operation({
        type: Schema.String,
        resolve: () => Effect.succeed("pong"),
      }),
    });

    expect(() => g.responseSchema("ping", {} as never)).toThrow(
      /opaque root does not accept a selection/,
    );
    expect(() => g.responseSchema("ping", { value: true } as never)).toThrow(
      /opaque root does not accept a selection/,
    );
  });

  it("still rejects `{}` on an opaque root after a cached no-selection schema", () => {
    const g = Domain.make({
      ping: operation({
        type: Schema.String,
        resolve: () => Effect.succeed("pong"),
      }),
    });

    // `{}` and `undefined` share a canonical cache key; the cached
    // no-selection codec must not mask the opaque-root rejection.
    expect(decode(g.responseSchema("ping", undefined), "pong")).toBe("pong");
    expect(() => g.responseSchema("ping", {} as never)).toThrow(
      /opaque root does not accept a selection/,
    );
  });

  it("rejects concrete selections for scalar array root response schemas", () => {
    const g = Domain.make({
      listIds: operation({
        type: Schema.Array(Schema.String),
        resolve: () => Effect.succeed(["1"]),
      }),
    });

    expect(() => g.responseSchema("listIds", { id: true } as never)).toThrow(
      /opaque root does not accept a selection/,
    );
  });

  it("builds a full dispatch result schema for successful responses", () => {
    const User = node("DispatchResultUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      get: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const schema = g.dispatchResultSchema("get", { id: true }, DispatchBoom);

    const decoded = decode(schema, {
      _tag: "Success",
      success: { id: "1" },
    }) as { _tag: string; success: { id: string } };

    expect(decoded._tag).toBe("Success");
    expect(decoded.success.id).toBe("1");
  });

  it("builds a full dispatch result schema for operation and gateway failures", () => {
    const User = node("DispatchFailureUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      get: operation({
        type: User,
        resolve: () => Effect.fail(new DispatchBoom({ message: "boom" })),
      }),
    });
    const schema = g.dispatchResultSchema("get", { id: true }, DispatchBoom);

    const operationFailure = decode(schema, {
      _tag: "Failure",
      failure: {
        _tag: "OperationError",
        operation: "get",
        cause: { _tag: "DispatchBoom", message: "boom" },
      },
    }) as { _tag: string; failure: unknown };

    expect(operationFailure._tag).toBe("Failure");
    expect(operationFailure.failure).toBeInstanceOf(OperationError);
    const error = operationFailure.failure as OperationError<DispatchBoom>;
    expect(error.operation).toBe("get");
    expect(error.cause).toBeInstanceOf(DispatchBoom);
    expect(error.cause.message).toBe("boom");

    const gatewayFailure = decode(schema, {
      _tag: "Failure",
      failure: { _tag: "UnknownOperation", operation: "missing" },
    }) as { _tag: string; failure: unknown };

    expect(gatewayFailure._tag).toBe("Failure");
    expect(gatewayFailure.failure).toBeInstanceOf(UnknownOperation);
  });

  it("unions reachable field error schemas into the dispatch failure codec", () => {
    class FieldBoom extends Schema.TaggedErrorClass<FieldBoom>()("FieldBoom", {
      reason: Schema.String,
    }) {}
    const User = node("FieldErrorUser", Schema.Struct({ id: Schema.String }), (f) => ({
      risky: f.field({
        type: Schema.String,
        error: FieldBoom,
        resolve: () => Effect.fail(new FieldBoom({ reason: "nope" })),
      }),
    }));
    const g = Domain.make({
      get: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const schema = g.dispatchResultSchemaDynamic("get", { id: true, risky: true });
    const decoded = decode(schema, {
      _tag: "Failure",
      failure: {
        _tag: "OperationError",
        operation: "get",
        cause: { _tag: "FieldBoom", reason: "nope" },
      },
    }) as { _tag: string; failure: OperationError<FieldBoom> };

    expect(decoded.failure).toBeInstanceOf(OperationError);
    expect(decoded.failure.cause).toBeInstanceOf(FieldBoom);
    expect(decoded.failure.cause.reason).toBe("nope");
  });

  it("rejects subscription names for dispatch result schemas", () => {
    expect(() =>
      domain.dispatchResultSchema("watchUsers" as never, { id: true } as never, DispatchBoom),
    ).toThrow("expected operation");
  });

  it("keeps cached response schemas separated by AST identity", () => {
    const g = Domain.make({
      getString: operation({
        type: node("StringNode", Schema.Struct({ value: Schema.String }), {}),
        resolve: () => Effect.succeed({ value: "x" }),
      }),
      getNumber: operation({
        type: node("NumberNode", Schema.Struct({ value: Schema.Number }), {}),
        resolve: () => Effect.succeed({ value: 1 }),
      }),
    });

    const selection = { value: true } as const;
    const stringSchema = g.responseSchema("getString", selection);
    const numberSchema = g.responseSchema("getNumber", selection);

    expect(() => decode(numberSchema, { value: "not-a-number" })).toThrow();
    expect((decode(numberSchema, { value: 1 }) as { value: number }).value).toBe(1);
    expect((decode(stringSchema, { value: "x" }) as { value: string }).value).toBe("x");
  });

  it("unions same-named fields across object-union variants", () => {
    const Text = node(
      "ResponseText",
      Schema.Struct({ _tag: Schema.Literal("text"), value: Schema.String }),
      {},
    );
    const Count = node(
      "ResponseCount",
      Schema.Struct({ _tag: Schema.Literal("count"), value: Schema.Number }),
      {},
    );
    const g = Domain.make({
      get: operation({
        type: Schema.Union([Text, Count]),
        resolve: () => Effect.succeed({ _tag: "count" as const, value: 1 }),
      }),
    });

    const selection = decode(g.selectionSchema("get"), { value: true });
    const schema = g.responseSchema("get", selection as Selection);

    expect((decode(schema, { value: "ok" }) as { value: unknown }).value).toBe("ok");
    expect((decode(schema, { value: 1 }) as { value: unknown }).value).toBe(1);
  });

  it("throws for unknown fields in unvalidated selections", () => {
    expect(() => domain.responseSchema("getUser", { nope: true } as Selection)).toThrow(
      /unknown selection field "nope"/,
    );
  });

  it("mirrors nullable object-union roots with multiple non-null variants", () => {
    const Text = node(
      "NullableResponseText",
      Schema.Struct({ _tag: Schema.Literal("text"), value: Schema.String }),
      {},
    );
    const Count = node(
      "NullableResponseCount",
      Schema.Struct({ _tag: Schema.Literal("count"), value: Schema.Number }),
      {},
    );
    const g = Domain.make({
      get: operation({
        type: Schema.Union([Text, Count, Schema.Null]),
        resolve: () => Effect.succeed(null),
      }),
    });

    const selection = decode(g.selectionSchema("get"), { value: true });
    const schema = g.responseSchema("get", selection as Selection);

    expect(decode(schema, null)).toBeNull();
    expect((decode(schema, { value: 1 }) as { value: unknown }).value).toBe(1);
  });

  it("mirrors nullable object roots as null or the projected object", () => {
    const User = node("NullableUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      maybeUser: operation({
        type: Schema.NullOr(User),
        resolve: () => Effect.succeed(null),
      }),
    });
    const selection = decode(g.selectionSchema("maybeUser"), { id: true });
    const schema = g.responseSchema("maybeUser", selection as Selection);

    expect(decode(schema, null)).toBeNull();
    expect((decode(schema, { id: "1" }) as { id: string }).id).toBe("1");
  });

  it("mirrors nullable array roots as null or the projected array", () => {
    const User = node("NullableArrayUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      maybeUsers: operation({
        type: Schema.NullOr(Schema.Array(User)),
        resolve: () => Effect.succeed(null),
      }),
    });
    const selection = decode(g.selectionSchema("maybeUsers"), { id: true });
    const schema = g.responseSchema("maybeUsers", selection as Selection);

    expect(decode(schema, null)).toBeNull();
    const decoded = decode(schema, [{ id: "1" }]) as ReadonlyArray<{ id: string }>;
    expect(decoded[0]!.id).toBe("1");
  });

  it("mirrors nested array roots as nested projected arrays", () => {
    const User = node("NestedArrayUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      userGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([]),
      }),
    });
    const selection = decode(g.selectionSchema("userGroups"), { id: true });
    const schema = g.responseSchema("userGroups", selection as Selection);

    const decoded = decode(schema, [[{ id: "1" }]]) as ReadonlyArray<ReadonlyArray<{ id: string }>>;
    expect(decoded[0]![0]!.id).toBe("1");
  });

  it("mirrors nullable nested array roots as null or nested projected arrays", () => {
    const User = node("NullableNestedArrayUser", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      maybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed(null),
      }),
    });
    const selection = decode(g.selectionSchema("maybeUserGroups"), { id: true });
    const schema = g.responseSchema("maybeUserGroups", selection as Selection);

    expect(decode(schema, null)).toBeNull();
    const present = decode(schema, [[{ id: "1" }]]) as ReadonlyArray<ReadonlyArray<{ id: string }>>;
    expect(present[0]![0]!.id).toBe("1");
  });

  it("mirrors array-wrapped union roots as projected arrays", () => {
    const selection = decode(unionGraph.selectionSchema("listPetVariant"), {
      _tag: true,
      name: true,
      meow: true,
      bark: true,
    });
    const schema = unionGraph.responseSchema("listPetVariant", selection as Selection);

    const decoded = decode(schema, [
      { _tag: "dog", name: "Rex", meow: undefined, bark: "Rex barks" },
    ]) as ReadonlyArray<Record<string, unknown>>;

    expect(decoded[0]!.meow).toBeUndefined();
    expect(decoded[0]!.bark).toBe("Rex barks");
  });

  it("mirrors nested selections on fields missing from object-union variants as undefined", () => {
    const Toy = node("ResponseMissingToy", Schema.Struct({ name: Schema.String }), {});
    const CatWithToys = node(
      "ResponseMissingCat",
      Schema.Struct({
        _tag: Schema.Literal("cat"),
        name: Schema.String,
        toys: Schema.Array(Toy),
      }),
      {},
    );
    const DogWithoutToys = node(
      "ResponseMissingDog",
      Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
      {},
    );
    const g = Domain.make({
      getPet: operation({
        type: Schema.Union([CatWithToys, DogWithoutToys]),
        resolve: () => Effect.succeed({ _tag: "dog" as const, name: "Rex" }),
      }),
    });

    const selection = decode(g.selectionSchema("getPet"), {
      _tag: true,
      toys: { select: { name: true } },
    });
    const schema = g.responseSchema("getPet", selection as Selection);

    const decoded = decode(schema, { _tag: "dog", toys: undefined }) as Record<string, unknown>;
    expect(decoded.toys).toBeUndefined();
  });

  it("property: executed valid selections round-trip the response codec", async () => {
    await fc.assert(
      fc.asyncProperty(validSelection, async (rawSelection) => {
        const selection = decode(propertyGraph.selectionSchema("getUser"), rawSelection);
        const result = await Effect.runPromise(
          propertyGraph.execute("getUser", { select: selection as never }),
        );
        const responseSchema = propertyGraph.responseSchema("getUser", selection as Selection);
        const decoded = decode(responseSchema, encode(responseSchema, result));

        expect(decoded).toEqual(result);
      }),
      { numRuns: 150 },
    );
  });

  it("property: decodes union root selections for every runtime variant", async () => {
    await fc.assert(
      fc.asyncProperty(
        unionSelection,
        fc.constantFrom("cat" as const, "dog" as const),
        async (rawSelection, variant) => {
          const selection = decode(unionGraph.selectionSchema("getPet"), rawSelection);
          const result = await Effect.runPromise(
            unionGraph.execute("getPet", { args: { variant }, select: selection as never }),
          );
          const responseSchema = unionGraph.responseSchema("getPet", selection as Selection);
          const decoded = decode(responseSchema, encode(responseSchema, result));

          expect(decoded).toEqual(result);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("property: decodes array-of-union selections", async () => {
    await fc.assert(
      fc.asyncProperty(unionSelection, async (rawSelection) => {
        const selection = decode(unionGraph.selectionSchema("listPets"), rawSelection);
        const result = await Effect.runPromise(
          unionGraph.execute("listPets", { select: selection as never }),
        );
        const responseSchema = unionGraph.responseSchema("listPets", selection as Selection);
        const decoded = decode(responseSchema, encode(responseSchema, result));

        expect(decoded).toEqual(result);
      }),
      { numRuns: 150 },
    );
  });
});
