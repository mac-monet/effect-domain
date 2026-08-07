import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { field, Domain, node, operation, type Selection } from "../src/index.ts";

function decode(schema: unknown, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input);
}

function toWire(schema: unknown, value: unknown): unknown {
  return Schema.encodeUnknownSync(schema as Schema.Codec<unknown>)(value);
}

const User = node(
  "ProjectionRegressionUser",
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
  "ProjectionRegressionCat",
  Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }),
  {
    meow: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} meows`),
    }),
  },
);

const Dog = node(
  "ProjectionRegressionDog",
  Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
  {
    bark: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} barks`),
    }),
  },
);

describe("projection shape regressions", () => {
  it("keeps selection, execution, dispatch, and response schema aligned for nullable nested array roots", async () => {
    const domain = Domain.make({
      maybeUserGroups: operation({
        type: Schema.NullOr(Schema.Array(Schema.Array(User))),
        resolve: () => Effect.succeed([[{ id: "1", firstName: "Ada", lastName: "Lovelace" }]]),
      }),
    });
    const selection = decode(domain.selectionSchema("maybeUserGroups"), {
      id: true,
      fullName: true,
    }) as Selection;

    const executed = await Effect.runPromise(
      domain.execute({ name: "maybeUserGroups", select: selection }),
    );
    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "maybeUserGroups", select: selection }),
    );
    const responseSchema = domain.responseSchema("maybeUserGroups", selection);
    const decoded = decode(responseSchema, toWire(responseSchema, executed));

    expect(Result.isSuccess(dispatched)).toBe(true);
    const groups = decoded as ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    expect(groups[0]![0]!.id).toBe("1");
    expect(groups[0]![0]!.fullName).toBe("Ada Lovelace");
  });

  it("keeps array-wrapped object union roots projectable across all public surfaces", async () => {
    const domain = Domain.make({
      listPets: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        resolve: () => Effect.succeed([{ _tag: "dog" as const, name: "Rex" }]),
      }),
    });
    const selection = decode(domain.selectionSchema("listPets"), {
      _tag: true,
      name: true,
      meow: true,
      bark: true,
    }) as Selection;

    const executed = await Effect.runPromise(
      domain.execute({ name: "listPets", select: selection }),
    );
    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "listPets", select: selection }),
    );
    const responseSchema = domain.responseSchema("listPets", selection);
    const decoded = decode(responseSchema, toWire(responseSchema, executed));

    expect(Result.isSuccess(dispatched)).toBe(true);
    const rows = decoded as ReadonlyArray<Record<string, unknown>>;
    expect(rows[0]!._tag).toBe("dog");
    expect(rows[0]!.meow).toBeUndefined();
    expect(rows[0]!.bark).toBe("Rex barks");
  });

  it("keeps nested nullable array union roots projectable", async () => {
    const raw = [{ id: "1", firstName: "Ada", lastName: "Lovelace" }];
    const domain = Domain.make({
      get: operation({
        type: Schema.Union([Schema.Array(User), Schema.NullOr(Schema.Array(User))]),
        resolve: () => Effect.succeed(raw),
      }),
    });
    const selection = decode(domain.selectionSchema("get"), {
      id: true,
      fullName: true,
    }) as Selection;

    const executed = await Effect.runPromise(domain.execute({ name: "get", select: selection }));
    const dispatched = await Effect.runPromise(domain.dispatch({ name: "get", select: selection }));
    const responseSchema = domain.responseSchema("get", selection);
    const decoded = decode(responseSchema, toWire(responseSchema, executed));

    expect(Result.isSuccess(dispatched)).toBe(true);
    const rows = decoded as ReadonlyArray<Record<string, unknown>>;
    expect(rows[0]!.id).toBe("1");
    expect(rows[0]!.fullName).toBe("Ada Lovelace");
  });

  it("treats mixed object/scalar roots as opaque across public surfaces", async () => {
    const domain = Domain.make({
      get: operation({
        type: Schema.Union([User, Schema.String]),
        resolve: () => Effect.succeed("opaque"),
      }),
    });

    const selectionSchema = domain.selectionSchema("get");
    expect(decode(selectionSchema, undefined)).toBeUndefined();
    expect(() => decode(selectionSchema, { id: true })).toThrow();
    expect(() => domain.responseSchema("get", { id: true } as never)).toThrow(
      /mixed object\/scalar union/i,
    );
    expect(decode(domain.responseSchema("get", undefined), "opaque")).toBe("opaque");

    const executed = await Effect.runPromise(domain.execute({ name: "get" }));
    expect(executed).toBe("opaque");
    const forcedExecute = await Effect.runPromiseExit(
      domain.execute({ name: "get", select: { id: true } } as never),
    );
    expect(forcedExecute._tag).toBe("Failure");

    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "get", select: { id: true } }),
    );
    expect(Result.isFailure(dispatched)).toBe(true);
  });

  it("treats mixed object/array union roots as opaque across public surfaces", async () => {
    const domain = Domain.make({
      get: operation({
        type: Schema.Union([User, Schema.Array(User)]),
        resolve: () => Effect.succeed([{ id: "1", firstName: "Ada", lastName: "Lovelace" }]),
      }),
    });

    const selectionSchema = domain.selectionSchema("get");
    expect(decode(selectionSchema, undefined)).toBeUndefined();
    expect(() => decode(selectionSchema, { id: true })).toThrow();
    expect(() => domain.responseSchema("get", { id: true } as never)).toThrow(
      /mixed collection union/i,
    );
    const raw = [{ id: "1", firstName: "Ada", lastName: "Lovelace" }];
    expect(decode(domain.responseSchema("get", undefined), raw)).toEqual(raw);

    const executed = await Effect.runPromise(domain.execute({ name: "get" }));
    expect(executed).toEqual(raw);
    const forcedExecute = await Effect.runPromiseExit(
      domain.execute({ name: "get", select: { id: true } } as never),
    );
    expect(forcedExecute._tag).toBe("Failure");

    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "get", select: { id: true } }),
    );
    expect(Result.isFailure(dispatched)).toBe(true);
  });

  it("treats array roots with mixed object/array union elements as opaque", async () => {
    const raw = [
      { id: "1", firstName: "Ada", lastName: "Lovelace" },
      [{ id: "2", firstName: "Grace", lastName: "Hopper" }],
    ];
    const domain = Domain.make({
      get: operation({
        type: Schema.Array(Schema.Union([User, Schema.Array(User)])),
        resolve: () => Effect.succeed(raw),
      }),
    });

    const selectionSchema = domain.selectionSchema("get");
    expect(decode(selectionSchema, undefined)).toBeUndefined();
    expect(() => decode(selectionSchema, { id: true })).toThrow();
    expect(() => domain.responseSchema("get", { id: true } as never)).toThrow(
      /opaque root does not accept a selection/i,
    );
    expect(decode(domain.responseSchema("get", undefined), raw)).toEqual(raw);

    const executed = await Effect.runPromise(domain.execute({ name: "get" }));
    expect(executed).toEqual(raw);
    const forcedExecute = await Effect.runPromiseExit(
      domain.execute({ name: "get", select: { id: true } } as never),
    );
    expect(forcedExecute._tag).toBe("Failure");

    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "get", select: { id: true } }),
    );
    expect(Result.isFailure(dispatched)).toBe(true);
  });

  it("treats array-wrapped union roots with mixed element collections as opaque", async () => {
    const raw = [{ id: "1", firstName: "Ada", lastName: "Lovelace" }];
    const domain = Domain.make({
      get: operation({
        type: Schema.Union([
          Schema.Array(Schema.Union([User, Schema.Array(User)])),
          Schema.Array(User),
        ]),
        resolve: () => Effect.succeed(raw),
      }),
    });

    const selectionSchema = domain.selectionSchema("get");
    expect(decode(selectionSchema, undefined)).toBeUndefined();
    expect(() => decode(selectionSchema, { id: true })).toThrow();
    expect(() => domain.responseSchema("get", { id: true } as never)).toThrow(
      /mixed collection union/i,
    );
    expect(decode(domain.responseSchema("get", undefined), raw)).toEqual(raw);

    const executed = await Effect.runPromise(domain.execute({ name: "get" }));
    expect(executed).toEqual(raw);
    const forcedExecute = await Effect.runPromiseExit(
      domain.execute({ name: "get", select: { id: true } } as never),
    );
    expect(forcedExecute._tag).toBe("Failure");

    const dispatched = await Effect.runPromise(
      domain.dispatch({ name: "get", select: { id: true } }),
    );
    expect(Result.isFailure(dispatched)).toBe(true);
  });
});
