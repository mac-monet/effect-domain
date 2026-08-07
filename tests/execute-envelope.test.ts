import { Effect, Schema, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Domain, field, node, operation, subscription } from "../src/index.ts";

class Boom extends Schema.TaggedErrorClass<Boom>()("EnvelopeBoom", {
  message: Schema.String,
}) {}

const User = node(
  "EnvelopeUser",
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
  { identity: "id" },
);

const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    error: Boom,
    resolve: ({ args }) =>
      args.id === "boom"
        ? Effect.fail(new Boom({ message: "nope" }))
        : Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
  }),
  countUsers: operation({
    type: Schema.Number,
    resolve: () => Effect.succeed(2),
  }),
  watchUser: subscription({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Stream.make(
        { id: args.id, firstName: "Alice", lastName: "Smith" },
        { id: args.id, firstName: "Alicia", lastName: "Smith" },
      ),
  }),
});

describe("execute envelope form", () => {
  it("executes one envelope with selection-dependent inference", async () => {
    const program = domain.execute({
      name: "getUser",
      args: { id: "1" },
      select: { id: true, fullName: true },
    });
    const user = await Effect.runPromise(program);

    expect(user).toEqual({ id: "1", fullName: "Alice Smith" });
    expectTypeOf(user).toEqualTypeOf<{ id: string; fullName: string }>();
    type E = typeof program extends Effect.Effect<infer _A, infer Err, infer _R> ? Err : never;
    expectTypeOf<E>().toEqualTypeOf<Boom>();
  });

  it("supports args-less operations", async () => {
    const count = await Effect.runPromise(domain.execute({ name: "countUsers" }));
    expect(count).toBe(2);
    expectTypeOf(count).toEqualTypeOf<number>();
  });

  it("nested selections narrow like the name-first form", async () => {
    const user = await Effect.runPromise(
      domain.execute({ name: "getUser", args: { id: "2" }, select: { firstName: true } }),
    );
    expect(user).toEqual({ firstName: "Alice" });
    expectTypeOf(user).toEqualTypeOf<{ firstName: string }>();
  });

  it("reads: true in options returns an Execution envelope", async () => {
    const execution = await Effect.runPromise(
      domain.execute({ name: "getUser", args: { id: "1" }, select: { id: true } }, { reads: true }),
    );
    expect(execution.result).toEqual({ id: "1" });
    expect(execution.reads).toEqual([{ node: "EnvelopeUser", key: "1" }]);
    expectTypeOf(execution.result).toEqualTypeOf<{ id: string }>();
  });

  it("accepts walker concurrency in options", async () => {
    const user = await Effect.runPromise(
      domain.execute(
        { name: "getUser", args: { id: "1" }, select: { fullName: true } },
        { concurrency: 1 },
      ),
    );
    expect(user).toEqual({ fullName: "Alice Smith" });
  });

  it("fails with the declared error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(domain.execute({ name: "getUser", args: { id: "boom" }, select: { id: true } })),
    );
    expect(error).toBeInstanceOf(Boom);
  });

  it("subscribe envelope form streams with inference", async () => {
    const items = await Effect.runPromise(
      Stream.runCollect(
        domain.subscribe(
          { name: "watchUser", args: { id: "1" }, select: { firstName: true } },
          { concurrency: "unbounded" },
        ),
      ),
    );
    expect(items).toEqual([{ firstName: "Alice" }, { firstName: "Alicia" }]);
    expectTypeOf(items).toEqualTypeOf<Array<{ firstName: string }>>();
  });

  it("client mirrors the envelope forms over the wire codec", async () => {
    const client = Domain.client(domain);
    const user = await Effect.runPromise(
      client.execute({ name: "getUser", args: { id: "1" }, select: { id: true, fullName: true } }),
    );
    expect(user).toEqual({ id: "1", fullName: "Alice Smith" });
    expectTypeOf(user).toEqualTypeOf<{ id: string; fullName: string }>();

    const error = await Effect.runPromise(
      Effect.flip(client.execute({ name: "getUser", args: { id: "boom" }, select: { id: true } })),
    );
    expect(error).toBeInstanceOf(Boom);

    const items = await Effect.runPromise(
      Stream.runCollect(
        client.subscribe({ name: "watchUser", args: { id: "1" }, select: { fullName: true } }),
      ),
    );
    expect(items).toEqual([{ fullName: "Alice Smith" }, { fullName: "Alicia Smith" }]);
    expectTypeOf(items).toEqualTypeOf<Array<{ fullName: string }>>();
  });

  it("rejects invalid envelopes at compile time", () => {
    // @ts-expect-error unknown operation name
    void (() => domain.execute({ name: "nope" }));
    // @ts-expect-error wrong args shape
    void (() => domain.execute({ name: "getUser", args: { id: 1 }, select: { id: true } }));
    // @ts-expect-error unknown selection key
    void (() => domain.execute({ name: "getUser", args: { id: "1" }, select: { nope: true } }));
    // @ts-expect-error subscriptions are not executable
    void (() => domain.execute({ name: "watchUser", args: { id: "1" }, select: { id: true } }));
    // @ts-expect-error operations are not subscribable
    void (() => domain.subscribe({ name: "getUser", args: { id: "1" }, select: { id: true } }));
  });

  it("policy keys inside the envelope are compile errors", () => {
    void (() =>
      domain.execute({
        name: "getUser",
        args: { id: "1" },
        select: { id: true },
        // @ts-expect-error reads belongs in the options argument
        reads: true,
      }));
    void (() =>
      domain.execute({
        name: "getUser",
        args: { id: "1" },
        select: { id: true },
        // @ts-expect-error concurrency belongs in the options argument
        concurrency: 4,
      }));
  });

  it("the removed name-first form no longer type-checks", () => {
    // @ts-expect-error name-first form was removed; use the envelope form
    void (() => domain.execute("getUser", { args: { id: "1" }, select: { id: true } }));
    // @ts-expect-error name-first form was removed; use the envelope form
    void (() => domain.subscribe("watchUser", { args: { id: "1" }, select: { id: true } }));
  });
});
