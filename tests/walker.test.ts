import { Deferred, Effect, Fiber, Option, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

const Post = node("Post", Schema.Struct({ id: Schema.String, title: Schema.String }), {
  upper: field({
    type: Schema.String,
    resolve: ({ parent }) => Effect.succeed(parent.title.toUpperCase()),
  }),
});

describe("Unit 2: walker — lists, nested objects, null handling", () => {
  it("recurses into nested object sub-selection", async () => {
    const Profile = node("Profile", Schema.Struct({ bio: Schema.String, age: Schema.Number }), {});

    const UserWithProfile = node(
      "UserWithProfile",
      Schema.Struct({ id: Schema.String, profile: Profile }),
      {},
    );

    const g = Domain.make({
      getUser: operation({
        type: UserWithProfile,
        resolve: () => Effect.succeed({ id: "1", profile: { bio: "hello", age: 30 } }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getUser", {
        select: { id: true, profile: { select: { bio: true } } },
      }),
    );

    expect(Result.getOrThrow(result.id)).toBe("1");
    const profileResult = Result.getOrThrow(result.profile) as Record<
      string,
      Result.Result<unknown, unknown>
    >;
    expect(Result.getOrThrow(profileResult.bio)).toBe("hello");
    expect("age" in profileResult).toBe(false);
  });

  it("walks array fields per-item with sub-selection", async () => {
    const UserWithPosts = node("UserWithPosts", Schema.Struct({ id: Schema.String }), {
      posts: field({
        type: Schema.Array(Post),
        resolve: () =>
          Effect.succeed([
            { id: "p1", title: "first" },
            { id: "p2", title: "second" },
          ]),
      }),
    });

    const g = Domain.make({
      getUser: operation({
        type: UserWithPosts,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getUser", {
        select: { posts: { select: { id: true, upper: true } } },
      }),
    );

    const posts = Result.getOrThrow(result.posts) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(posts).toHaveLength(2);
    expect(Result.getOrThrow(posts[0].id)).toBe("p1");
    expect(Result.getOrThrow(posts[0].upper)).toBe("FIRST");
    expect(Result.getOrThrow(posts[1].id)).toBe("p2");
    expect(Result.getOrThrow(posts[1].upper)).toBe("SECOND");
  });

  it("walks inline array data fields (not computed) with sub-selection", async () => {
    const Item = Schema.Struct({ name: Schema.String });
    const Container = node("Container", Schema.Struct({ items: Schema.Array(Item) }), {});

    const g = Domain.make({
      get: operation({
        type: Container,
        resolve: () => Effect.succeed({ items: [{ name: "a" }, { name: "b" }] }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("get", { select: { items: { select: { name: true } } } }),
    );

    const items = Result.getOrThrow(result.items) as Array<
      Record<string, Result.Result<unknown, unknown>>
    >;
    expect(items).toHaveLength(2);
    expect(Result.getOrThrow(items[0].name)).toBe("a");
    expect(Result.getOrThrow(items[1].name)).toBe("b");
  });

  it("handles null parent at boundary — returns Option.none(), not walked object", async () => {
    const Profile = node("NullableProfile", Schema.Struct({ bio: Schema.String }), {});

    const UserWithNullable = node("UserWithNullable", Schema.Struct({ id: Schema.String }), {
      profile: field({
        type: Schema.NullOr(Profile),
        resolve: () => Effect.succeed(null),
      }),
    });

    const g = Domain.make({
      getUser: operation({
        type: UserWithNullable,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("getUser", {
        select: { profile: { select: { bio: true } } },
      }),
    );

    expect(
      Option.isNone(Result.getOrThrow(result.profile) as unknown as Option.Option<unknown>),
    ).toBe(true);
  });

  it("handles null in data field — returns Option.none()", async () => {
    const WithNullable = node(
      "WithNullable",
      Schema.Struct({ name: Schema.NullOr(Schema.Struct({ first: Schema.String })) }),
      {},
    );

    const g = Domain.make({
      get: operation({
        type: WithNullable,
        resolve: () => Effect.succeed({ name: null }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("get", { select: { name: { select: { first: true } } } }),
    );

    expect(Option.isNone(Result.getOrThrow(result.name) as unknown as Option.Option<unknown>)).toBe(
      true,
    );
  });

  it("concurrency defaults to unbounded", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()]);
        const release = yield* Deferred.make<void>();
        let startedCount = 0;
        let concurrentCount = 0;
        let maxConcurrent = 0;

        function trackedField(label: string) {
          return field({
            type: Schema.String,
            resolve: () =>
              Effect.gen(function* () {
                const index = startedCount++;
                concurrentCount++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCount);
                yield* Deferred.succeed(started[index]!, undefined);
                yield* Deferred.await(release);
                concurrentCount--;
                return label;
              }),
          });
        }

        const SlowNode = node("SlowNode", Schema.Struct({ id: Schema.String }), {
          a: trackedField("a"),
          b: trackedField("b"),
        });

        const g = Domain.make({
          get: operation({
            type: SlowNode,
            resolve: () => Effect.succeed({ id: "1" }),
          }),
        });

        const fiber = yield* g
          .execute("get", { select: { a: true, b: true } })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started[0]!);
        yield* Deferred.await(started[1]!);
        expect(maxConcurrent).toBe(2);

        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);

        expect(Result.getOrThrow(result.a)).toBe("a");
        expect(Result.getOrThrow(result.b)).toBe("b");
      }),
    );
  });

  it("concurrency configurable via execute() config", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Effect.all([
          Deferred.make<void>(),
          Deferred.make<void>(),
          Deferred.make<void>(),
        ]);
        const releases = yield* Effect.all([
          Deferred.make<void>(),
          Deferred.make<void>(),
          Deferred.make<void>(),
        ]);
        let startedCount = 0;
        let concurrentCount = 0;
        let maxConcurrent = 0;

        function trackedField(label: string) {
          return field({
            type: Schema.String,
            resolve: () =>
              Effect.gen(function* () {
                const index = startedCount++;
                concurrentCount++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCount);
                yield* Deferred.succeed(started[index]!, undefined);
                yield* Deferred.await(releases[index]!);
                concurrentCount--;
                return label;
              }),
          });
        }

        const TrackedNode = node("TrackedNode", Schema.Struct({ id: Schema.String }), {
          a: trackedField("a"),
          b: trackedField("b"),
          c: trackedField("c"),
        });

        const g = Domain.make({
          get: operation({
            type: TrackedNode,
            resolve: () => Effect.succeed({ id: "1" }),
          }),
        });

        const fiber = yield* g
          .execute("get", { select: { a: true, b: true, c: true }, concurrency: 1 })
          .pipe(Effect.forkChild({ startImmediately: true }));

        for (let i = 0; i < releases.length; i++) {
          yield* Deferred.await(started[i]!);
          expect(maxConcurrent).toBe(1);
          expect(concurrentCount).toBe(1);
          yield* Deferred.succeed(releases[i]!, undefined);
        }

        const result = yield* Fiber.join(fiber);

        expect(Result.getOrThrow(result.a)).toBe("a");
        expect(Result.getOrThrow(result.b)).toBe("b");
        expect(Result.getOrThrow(result.c)).toBe("c");
      }),
    );
  });

  it("deeply nested objects recurse multiple levels", async () => {
    const Address = node("Address", Schema.Struct({ city: Schema.String }), {});
    const Profile = node("DeepProfile", Schema.Struct({ address: Address }), {});
    const UserDeep = node("UserDeep", Schema.Struct({ id: Schema.String, profile: Profile }), {});

    const g = Domain.make({
      get: operation({
        type: UserDeep,
        resolve: () => Effect.succeed({ id: "1", profile: { address: { city: "NYC" } } }),
      }),
    });

    const result = await Effect.runPromise(
      g.execute("get", {
        select: {
          profile: { select: { address: { select: { city: true } } } },
        },
      }),
    );

    const profile = Result.getOrThrow(result.profile) as Record<
      string,
      Result.Result<unknown, unknown>
    >;
    const address = Result.getOrThrow(profile.address) as Record<
      string,
      Result.Result<unknown, unknown>
    >;
    expect(Result.getOrThrow(address.city)).toBe("NYC");
  });
});
