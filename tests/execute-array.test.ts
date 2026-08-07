import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", {
  message: Schema.String,
}) {}

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
});

describe("execute array overload", () => {
  it("returns a tuple of per-entry results", async () => {
    const program = domain.execute([
      { name: "getUser", args: { id: "1" }, select: { id: true, fullName: true } },
      { name: "countUsers" },
      { name: "getUser", args: { id: "2" }, select: { firstName: true } },
    ]);
    const [user, count, other] = await Effect.runPromise(program);

    expect(user).toEqual({ id: "1", fullName: "Alice Smith" });
    expect(count).toBe(2);
    expect(other).toEqual({ firstName: "Alice" });

    // Per-entry selection-dependent types and error union survive inference.
    expectTypeOf(user).toEqualTypeOf<{ id: string; fullName: string }>();
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf(other).toEqualTypeOf<{ firstName: string }>();
    type E = typeof program extends Effect.Effect<infer _A, infer Err, infer _R> ? Err : never;
    expectTypeOf<E>().toEqualTypeOf<Boom>();
  });

  it("empty array short-circuits to []", async () => {
    expect(await Effect.runPromise(domain.execute([]))).toEqual([]);
  });

  it("fails the whole batch on the first failing entry", async () => {
    const exit = await Effect.runPromiseExit(
      domain.execute([
        { name: "getUser", args: { id: "boom" }, select: { id: true } },
        { name: "countUsers" },
      ]),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("batched fields coalesce across entries in one batch call", async () => {
    let batchCalls = 0;
    let lastKeys: ReadonlyArray<string> = [];
    const Author = node("ArrayOverlapAuthor", Schema.Struct({ id: Schema.String }), {
      posts: field({
        type: Schema.Array(Schema.Struct({ title: Schema.String })),
        key: (author: { id: string }) => author.id,
        resolve: (keys: ReadonlyArray<string>) => {
          batchCalls++;
          lastKeys = [...keys];
          return Effect.succeed(new Map(keys.map((key) => [key, [{ title: `Post by ${key}` }]])));
        },
      }),
    });
    const g = Domain.make({
      getAuthor: operation({
        type: Author,
        args: Schema.Struct({ id: Schema.String }),
        resolve: ({ args }) => Effect.succeed({ id: args.id }),
      }),
    });

    const [a, b] = await Effect.runPromise(
      g.execute([
        { name: "getAuthor", args: { id: "a1" }, select: { posts: { select: { title: true } } } },
        { name: "getAuthor", args: { id: "a2" }, select: { posts: { select: { title: true } } } },
      ]),
    );

    expect(a.posts).toEqual([{ title: "Post by a1" }]);
    expect(b.posts).toEqual([{ title: "Post by a2" }]);
    expect(batchCalls).toBe(1);
    expect([...lastKeys].sort()).toEqual(["a1", "a2"]);
  });

  it("single-op form is unaffected", async () => {
    const user = await Effect.runPromise(
      domain.execute("getUser", { args: { id: "1" }, select: { fullName: true } }),
    );
    expect(user).toEqual({ fullName: "Alice Smith" });
    expectTypeOf(user).toEqualTypeOf<{ fullName: string }>();
  });

  it("client mirrors the array overload over the wire codec", async () => {
    const client = Domain.client(domain);
    const [user, count] = await Effect.runPromise(
      client.execute([
        { name: "getUser", args: { id: "1" }, select: { id: true, fullName: true } },
        { name: "countUsers" },
      ]),
    );

    expect(user).toEqual({ id: "1", fullName: "Alice Smith" });
    expect(count).toBe(2);
    expectTypeOf(user).toEqualTypeOf<{ id: string; fullName: string }>();
  });

  it("client array entries decode declared errors back to class instances", async () => {
    const client = Domain.client(domain);
    const error = await Effect.runPromise(
      Effect.flip(
        client.execute([{ name: "getUser", args: { id: "boom" }, select: { id: true } }]),
      ),
    );
    expect(error).toBeInstanceOf(Boom);
  });
});
