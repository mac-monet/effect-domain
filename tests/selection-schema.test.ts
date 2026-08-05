import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { field, Domain, node, operation } from "../src/index.ts";

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
    greeting: field({
      type: Schema.String,
      args: Schema.Struct({ name: Schema.String }),
      resolve: ({ args }) => Effect.succeed(`Hello, ${args.name}`),
    }),
  },
);

const userGraph = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) => Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
  }),
  ping: operation({
    type: Schema.String,
    resolve: () => Effect.succeed("pong"),
  }),
});

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

interface CommentFields {
  readonly body: string;
  readonly replies: ReadonlyArray<CommentFields>;
  readonly shout?: string;
}

const Comment = node(
  "Comment",
  Schema.Struct({
    body: Schema.String,
    replies: Schema.Array(Schema.suspend((): Schema.Codec<CommentFields> => Comment as never)),
  }),
  {
    shout: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(parent.body.toUpperCase()),
    }),
  },
);

function decodeOk(schema: unknown, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
}

function decodeFails(schema: unknown, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
    return false;
  } catch {
    return true;
  }
}

describe("Unit 9: argsSchema", () => {
  it("returns operation's args schema when present", () => {
    const schema = userGraph.argsSchema("getUser");
    expect(decodeOk(schema, { id: "1" })).toEqual({ id: "1" });
  });

  it("returns Schema.Void when operation has no args", () => {
    const schema = userGraph.argsSchema("ping");
    expect(decodeOk(schema, undefined)).toBeUndefined();
  });

  it("argsSchema rejects malformed args with ParseError", () => {
    const schema = userGraph.argsSchema("getUser");
    expect(decodeFails(schema, { id: 42 })).toBe(true);
    expect(decodeFails(schema, {})).toBe(true);
  });

  it("memoizes per operation name", () => {
    const a = userGraph.argsSchema("getUser");
    const b = userGraph.argsSchema("getUser");
    expect(a).toBe(b);
  });
});

describe("Unit 9: selectionSchema — plain struct", () => {
  it("accepts { field: true } for scalar fields", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { id: true })).toEqual({ id: true });
    expect(decodeOk(schema, { id: true, firstName: true, lastName: true })).toEqual({
      id: true,
      firstName: true,
      lastName: true,
    });
  });

  it("accepts computed scalar field as true", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { fullName: true })).toEqual({ fullName: true });
  });

  it("rejects unknown field keys with ParseError", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeFails(schema, { bogus: true })).toBe(true);
  });

  it("rejects wrong leaf type (string instead of true)", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeFails(schema, { id: "yes" })).toBe(true);
    expect(decodeFails(schema, { id: false })).toBe(true);
    expect(decodeFails(schema, { id: 1 })).toBe(true);
  });

  it("accepts { args } for scalar fields with args (disjoint from true)", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { greeting: true })).toEqual({ greeting: true });
    expect(decodeOk(schema, { greeting: { args: { name: "Bob" } } })).toEqual({
      greeting: { args: { name: "Bob" } },
    });
  });

  it("accepts alias as a string for output rename", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { id: { alias: "myId" } })).toEqual({
      id: { alias: "myId" },
    });
    expect(decodeOk(schema, { fullName: { alias: "name" } })).toEqual({
      fullName: { alias: "name" },
    });
  });

  it("rejects aliases that collide across fields", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeFails(schema, { firstName: { alias: "name" }, fullName: { alias: "name" } })).toBe(
      true,
    );
  });

  it("rejects non-string alias", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeFails(schema, { id: { alias: 42 } })).toBe(true);
  });

  it("rejects unknown source field (source is no longer supported)", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeFails(schema, { id: { source: "id" } })).toBe(true);
  });
});

describe("Unit 12: selectionSchema — root output shapes", () => {
  it("array object roots use the element selection schema", () => {
    const g = Domain.make({
      listUsers: operation({
        type: Schema.Array(User),
        resolve: () => Effect.succeed([]),
      }),
    });

    const schema = g.selectionSchema("listUsers");
    expect(decodeOk(schema, { id: true, fullName: true })).toEqual({
      id: true,
      fullName: true,
    });
    expect(decodeFails(schema, { users: { select: { id: true } } })).toBe(true);
  });

  it("projectable roots accept omitted selection", () => {
    const schema = userGraph.selectionSchema("getUser");
    type Decoded = Schema.Schema.Type<typeof schema>;
    expectTypeOf<undefined>().toMatchTypeOf<Decoded>();
    expect(decodeOk(schema, undefined)).toBeUndefined();
  });

  it("scalar roots accept only omitted selection", () => {
    const schema = userGraph.selectionSchema("ping");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, {})).toBe(true);
    expect(decodeFails(schema, true)).toBe(true);
    expect(decodeFails(schema, { value: true })).toBe(true);
  });

  it("scalar array roots accept only omitted selection", () => {
    const g = Domain.make({
      listIds: operation({
        type: Schema.Array(Schema.String),
        resolve: () => Effect.succeed(["1"]),
      }),
    });

    const schema = g.selectionSchema("listIds");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { id: true })).toBe(true);
  });

  it("nested array roots use the innermost element selection schema", () => {
    const g = Domain.make({
      listUserGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([]),
      }),
    });

    const schema = g.selectionSchema("listUserGroups");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeOk(schema, { id: true, fullName: true })).toEqual({
      id: true,
      fullName: true,
    });
    expect(decodeFails(schema, { users: { select: { id: true } } })).toBe(true);
  });

  it("nullable object roots use the object selection schema", () => {
    const g = Domain.make({
      getMaybeUser: operation({
        type: Schema.NullOr(User),
        resolve: () => Effect.succeed(null),
      }),
    });

    const schema = g.selectionSchema("getMaybeUser");
    expect(decodeOk(schema, { id: true })).toEqual({ id: true });
    expect(decodeFails(schema, { nope: true })).toBe(true);
  });

  it("nullable array roots use the element selection schema", () => {
    const g = Domain.make({
      getMaybeUsers: operation({
        type: Schema.NullOr(Schema.Array(User)),
        resolve: () => Effect.succeed(null),
      }),
    });

    const schema = g.selectionSchema("getMaybeUsers");
    expect(decodeOk(schema, { id: true })).toEqual({ id: true });
    expect(decodeFails(schema, { users: { select: { id: true } } })).toBe(true);
  });

  it("nullable nested array roots use the innermost element selection schema", () => {
    const g = Domain.make({
      getMaybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed(null),
      }),
    });

    const schema = g.selectionSchema("getMaybeUserGroups");
    expect(decodeOk(schema, { id: true, fullName: true })).toEqual({
      id: true,
      fullName: true,
    });
    expect(decodeFails(schema, { users: { select: { id: true } } })).toBe(true);
  });

  it("array-wrapped union roots use the innermost variant selection schema", () => {
    const g = Domain.make({
      listPets: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        resolve: () => Effect.succeed([{ _tag: "cat" as const, name: "Milo" }]),
      }),
    });

    const schema = g.selectionSchema("listPets");
    expect(decodeOk(schema, { _tag: true, name: true, meow: true, bark: true })).toEqual({
      _tag: true,
      name: true,
      meow: true,
      bark: true,
    });
  });

  it("treats nullable array roots with mixed object/scalar union elements as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.NullOr(Schema.Array(Schema.Union([User, Schema.String]))),
        resolve: () => Effect.succeed(null),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { id: true })).toBe(true);
  });

  it("treats array roots with mixed object/array union elements as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.Array(Schema.Union([User, Schema.Array(User)])),
        resolve: () => Effect.succeed([]),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { id: true })).toBe(true);
  });

  it("treats array-wrapped union roots with mixed element collections as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.Union([
          Schema.Array(Schema.Union([User, Schema.Array(User)])),
          Schema.Array(User),
        ]),
        resolve: () => Effect.succeed([]),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { id: true })).toBe(true);
  });

  it("treats mixed object/scalar union roots as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.Union([User, Schema.String]),
        resolve: () => Effect.succeed("x"),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { id: true })).toBe(true);
  });

  it("treats scalar-only union roots as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.Union([Schema.String, Schema.Number]),
        resolve: () => Effect.succeed("x"),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { value: true })).toBe(true);
  });

  it("treats null-or-scalar roots as opaque", () => {
    const g = Domain.make({
      get: operation({
        type: Schema.NullOr(Schema.String),
        resolve: () => Effect.succeed(null),
      }),
    });

    const schema = g.selectionSchema("get");
    expect(decodeOk(schema, undefined)).toBeUndefined();
    expect(decodeFails(schema, { value: true })).toBe(true);
  });
});

describe("Unit 9: selectionSchema — array form / multi-alias", () => {
  it("accepts single-entry array form: { id: [true] }", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { id: [true] })).toEqual({ id: [true] });
  });

  it("accepts single-entry array form with struct entry", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { greeting: [{ args: { name: "Bob" } }] })).toEqual({
      greeting: [{ args: { name: "Bob" } }],
    });
  });

  it("accepts multi-entry array with aliases on extra entries", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(
      decodeOk(schema, {
        greeting: [{ args: { name: "Bob" } }, { args: { name: "Alice" }, alias: "greetAlice" }],
      }),
    ).toEqual({
      greeting: [{ args: { name: "Bob" } }, { args: { name: "Alice" }, alias: "greetAlice" }],
    });
  });

  it("rejects multi-entry array with N>1 missing alias", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(
      decodeFails(schema, {
        greeting: [{ args: { name: "Bob" } }, { args: { name: "Alice" } }],
      }),
    ).toBe(true);
  });

  it("rejects multi-entry array with duplicate aliases", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(
      decodeFails(schema, {
        greeting: [
          { args: { name: "Bob" }, alias: "g" },
          { args: { name: "Alice" }, alias: "g" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects multi-entry array when an explicit alias collides with the implicit field name", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(
      decodeFails(schema, {
        greeting: [{ args: { name: "Bob" } }, { args: { name: "Alice" }, alias: "greeting" }],
      }),
    ).toBe(true);
  });

  it("accepts alias in nested selection (deep multi-alias)", () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Cat,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });
    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const schema = g.selectionSchema("getOwner");
    expect(
      decodeOk(schema, {
        pet: { select: { name: { alias: "petName" }, meow: true } },
      }),
    ).toEqual({
      pet: { select: { name: { alias: "petName" }, meow: true } },
    });
  });
});

describe("Unit 9: selectionSchema — object/array fields", () => {
  it("accepts both true and { select } for object fields", () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Cat,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });
    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const schema = g.selectionSchema("getOwner");
    expect(decodeOk(schema, { pet: true })).toEqual({ pet: true });
    expect(decodeOk(schema, { pet: { select: { name: true, meow: true } } })).toEqual({
      pet: { select: { name: true, meow: true } },
    });
  });

  it("accepts true and { select } for array fields", () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pets: field({
        type: Schema.Array(Cat),
        resolve: () => Effect.succeed([{ _tag: "cat" as const, name: "X" }]),
      }),
    });
    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const schema = g.selectionSchema("getOwner");
    expect(decodeOk(schema, { pets: true })).toEqual({ pets: true });
    expect(decodeOk(schema, { pets: { select: { name: true } } })).toEqual({
      pets: { select: { name: true } },
    });
  });

  it("rejects unknown nested keys", () => {
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      pet: field({
        type: Cat,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "X" }),
      }),
    });
    const g = Domain.make({
      getOwner: operation({
        type: Owner,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const schema = g.selectionSchema("getOwner");
    expect(decodeFails(schema, { pet: { select: { bogus: true } } })).toBe(true);
  });
});

describe("Unit 9: selectionSchema — sentinel-discriminated unions", () => {
  it("accepts the flat union shape (matches walker contract)", () => {
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
    const schema = g.selectionSchema("getOwner");
    expect(
      decodeOk(schema, {
        pet: { select: { _tag: true, name: true, meow: true, bark: true } },
      }),
    ).toEqual({ pet: { select: { _tag: true, name: true, meow: true, bark: true } } });
  });

  it("accepts union as operation type", () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });
    const schema = g.selectionSchema("getPet");
    expect(decodeOk(schema, { _tag: true, name: true, meow: true, bark: true })).toEqual({
      _tag: true,
      name: true,
      meow: true,
      bark: true,
    });
  });

  it("rejects keys that are not on any variant", () => {
    const g = Domain.make({
      getPet: operation({
        type: Pet,
        resolve: () => Effect.succeed({ _tag: "cat" as const, name: "Whiskers" }),
      }),
    });
    const schema = g.selectionSchema("getPet");
    expect(decodeFails(schema, { totallyBogus: true })).toBe(true);
  });

  it("unions per-field sub-schemas when same field has different types in variants", () => {
    const NumPayload = node(
      "NumPayload",
      Schema.Struct({ _tag: Schema.Literal("num"), payload: Schema.Number }),
      {},
    );
    const StrPayload = node(
      "StrPayload",
      Schema.Struct({ _tag: Schema.Literal("str"), payload: Schema.String }),
      {},
    );
    const Mixed = Schema.Union([NumPayload, StrPayload]);

    const g = Domain.make({
      get: operation({
        type: Mixed,
        resolve: () => Effect.succeed({ _tag: "num" as const, payload: 1 }),
      }),
    });

    const schema = g.selectionSchema("get");
    // payload appears as a scalar on both variants — both shapes accepted
    expect(decodeOk(schema, { _tag: true, payload: true })).toEqual({
      _tag: true,
      payload: true,
    });
  });

  it("Domain.make raises a clear error when union node is non-sentinel-discriminated", () => {
    const A = node("PlainA", Schema.Struct({ a: Schema.String }), {});
    const B = node("PlainB", Schema.Struct({ b: Schema.Number }), {});
    const Bad = Schema.Union([A, B]);
    const g = Domain.make({
      getBad: operation({
        type: Bad,
        resolve: () => Effect.succeed({ a: "x" }),
      }),
    });
    expect(() => g.selectionSchema("getBad")).toThrow(/sentinel|discrimin/i);
  });
});

describe("Unit 9: selectionSchema — recursion", () => {
  it("recursive nodes (Schema.suspend) round-trip without infinite expansion", () => {
    const g = Domain.make({
      getThread: operation({
        type: Comment,
        resolve: () => Effect.succeed({ body: "x", replies: [] }),
      }),
    });

    const schema = g.selectionSchema("getThread");
    const sel = {
      body: true,
      shout: true,
      replies: {
        select: {
          body: true,
          shout: true,
          replies: { select: { body: true, shout: true } },
        },
      },
    };
    expect(decodeOk(schema, sel)).toEqual(sel);
  });

  it("recursive selectionSchema is referentially stable", () => {
    const g = Domain.make({
      getThread: operation({
        type: Comment,
        resolve: () => Effect.succeed({ body: "x", replies: [] }),
      }),
    });
    const a = g.selectionSchema("getThread");
    const b = g.selectionSchema("getThread");
    expect(a).toBe(b);
  });
});

describe("Unit 9: selectionSchema — caching", () => {
  it("returns the same Schema instance on repeated calls", () => {
    const a = userGraph.selectionSchema("getUser");
    const b = userGraph.selectionSchema("getUser");
    expect(a).toBe(b);
  });

  it("different operations get distinct memoized instances", () => {
    const a = userGraph.selectionSchema("getUser");
    const b = userGraph.selectionSchema("ping");
    expect(a).not.toBe(b);
  });
});

describe("Unit 9: selectionSchema — accepts existing test selections", () => {
  it("accepts simple scalar selection from Unit 1 tests", () => {
    const schema = userGraph.selectionSchema("getUser");
    expect(decodeOk(schema, { id: true, fullName: true })).toEqual({
      id: true,
      fullName: true,
    });
  });

  it("accepts nested object selection", () => {
    const Profile = node(
      "Profile",
      Schema.Struct({ bio: Schema.String, address: Schema.Struct({ city: Schema.String }) }),
      {},
    );
    const Owner = node("Owner", Schema.Struct({ id: Schema.String }), {
      profile: field({
        type: Profile,
        resolve: () => Effect.succeed({ bio: "hi", address: { city: "NYC" } }),
      }),
    });
    const g = Domain.make({
      get: operation({ type: Owner, resolve: () => Effect.succeed({ id: "1" }) }),
    });
    const schema = g.selectionSchema("get");
    expect(
      decodeOk(schema, {
        id: true,
        profile: { select: { bio: true, address: { select: { city: true } } } },
      }),
    ).toEqual({
      id: true,
      profile: { select: { bio: true, address: { select: { city: true } } } },
    });
  });

  it("the decoded selection is then valid for domain.execute", async () => {
    const schema = userGraph.selectionSchema("getUser");
    const decoded = decodeOk(schema, { id: true, fullName: true });
    const result = await Effect.runPromise(
      // biome-ignore lint/suspicious/noExplicitAny: integration check
      userGraph.execute("getUser", { args: { id: "1" }, select: decoded as any }),
    );
    expect(result.id).toBe("1");
    expect(result.fullName).toBe("Alice Smith");
  });
});
