import { Effect, Layer, Result, Schema, Stream } from "effect";
import { Rpc, RpcGroup, RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserRepoLive } from "../examples/domain.ts";
import { Domain, node, operation, subscription } from "../src/index.ts";

const userSelect = { id: true, fullName: true } as const;

const Rpcs = RpcGroup.make(
  Rpc.make("getUser", {
    payload: domain.argsSchema("getUser"),
    success: domain.responseSchema("getUser", userSelect),
    error: Schema.Unknown,
  }),
  Rpc.make("createUser", {
    payload: domain.argsSchema("createUser"),
    success: domain.responseSchema("createUser", userSelect),
    error: Schema.Unknown,
  }),
);

const RenamedRpcs = RpcGroup.make(
  Rpc.make("getUserById", {
    payload: Schema.Struct({ userId: Schema.String }),
    success: domain.responseSchema("getUser", userSelect),
    error: Schema.Unknown,
  }),
);

const PingGraph = Domain.make({
  ping: operation({
    type: Schema.String,
    resolve: () => Effect.succeed("pong"),
  }),
});

const PingRpcs = RpcGroup.make(
  Rpc.make("ping", {
    success: Schema.String,
  }),
);

const FullNameRpcs = RpcGroup.make(
  Rpc.make("getUser", {
    payload: domain.argsSchema("getUser"),
    success: domain.responseSchema("getUser", { fullName: true }),
    error: Schema.Unknown,
  }),
);

const Counter = node("Counter", Schema.Struct({ value: Schema.Number }), (f) => ({
  doubled: f.field({
    type: Schema.Number,
    resolve: ({ parent }) => Effect.succeed(parent.value * 2),
  }),
}));

const streamGraph = Domain.make({
  watchCounters: subscription({
    type: Counter,
    args: Schema.Struct({ start: Schema.Number }),
    resolve: ({ args }) => Stream.make({ value: args.start }, { value: args.start + 1 }),
  }),
  failCounters: subscription({
    type: Counter,
    resolve: () => Stream.concat(Stream.make({ value: 1 }), Stream.fail("stream-error")),
  }),
  failCountersWithError: subscription({
    type: Counter,
    resolve: () => Stream.concat(Stream.make({ value: 1 }), Stream.fail(new Error("boom"))),
  }),
});

const counterSelect = { value: true, doubled: true } as const;

const StreamRpcs = RpcGroup.make(
  Rpc.make("watchCounters", {
    payload: streamGraph.argsSchema("watchCounters"),
    success: streamGraph.responseSchema("watchCounters", counterSelect),
    error: Schema.String,
    stream: true,
  }),
  Rpc.make("renamedCounters", {
    payload: Schema.Struct({ from: Schema.Number }),
    success: streamGraph.responseSchema("watchCounters", counterSelect),
    error: Schema.String,
    stream: true,
  }),
  Rpc.make("failCounters", {
    success: streamGraph.responseSchema("failCounters", counterSelect),
    error: Schema.String,
    stream: true,
  }),
);

describe("Domain binding", () => {
  it("exposes domain schemas in Rpc declarations", () => {
    const args = Effect.runSync(
      Schema.decodeUnknownEffect(domain.argsSchema("createUser"))({
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    );
    const select = Effect.runSync(
      Schema.decodeUnknownEffect(domain.selectionSchema("getUser"))(userSelect),
    );
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(domain.responseSchema("getUser", userSelect))({
        id: { _tag: "Success", success: "1" },
        fullName: { _tag: "Success", success: "Ada Lovelace" },
      }),
    ) as Record<string, Result.Result<string, unknown>>;

    expect(args).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(select).toEqual(userSelect);
    expect(Result.getOrThrow(decoded.fullName)).toBe("Ada Lovelace");
  });

  it("composes domain-backed operation services with native RpcGroup.toLayer", async () => {
    const users = domain.bind({
      getUser: { select: userSelect },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    const Live = Rpcs.toLayer({
      getUser: users.getUser,
      createUser: users.createUser,
    }).pipe(Layer.provide(UserRepoLive));

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(Rpcs);
      const user = yield* client.getUser({ id: "1" });
      const created = yield* client.createUser({ firstName: "Ada", lastName: "Lovelace" });
      return { user, created };
    });

    const { user, created } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(Live))) as unknown as Effect.Effect<
        {
          readonly user: Record<string, Result.Result<string, unknown>>;
          readonly created: Record<string, Result.Result<string, unknown>>;
        },
        unknown,
        never
      >,
    );
    expect(Result.getOrThrow(user.fullName)).toBe("Alice Anderson");
    expect(Result.getOrThrow(created.fullName)).toBe("Ada Lovelace");
  });

  it("supports renamed procedures with explicit args projection", async () => {
    const users = domain.bind({
      getUser: { select: userSelect },
    });
    const Live = RenamedRpcs.toLayer({
      getUserById: (payload) => users.getUser({ id: payload.userId }),
    }).pipe(Layer.provide(UserRepoLive));

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RenamedRpcs);
      return yield* client.getUserById({ userId: "1" });
    });

    const user = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(Live))));
    expect(Result.getOrThrow(user.fullName)).toBe("Alice Anderson");
  });

  it("supports scalar root operations without a selection", async () => {
    const pings = PingGraph.bind({
      ping: {},
    });
    const Live = PingRpcs.toLayer({
      ping: pings.ping,
    });

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(PingRpcs);
      return yield* client.ping();
    });

    await expect(
      Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(Live)))),
    ).resolves.toBe("pong");
    expect(PingGraph.responseSchema("ping")).toBeDefined();
  });

  it("requires args projection when payload does not match domain args", () => {
    const users = domain.bind({
      getUser: { select: userSelect },
    });
    RenamedRpcs.toLayer({
      // @ts-expect-error payload { userId } does not match getUser args { id }.
      getUserById: users.getUser,
    });
  });

  it("lets native RpcGroup reject success schema drift", () => {
    const users = domain.bind({
      getUser: { select: { id: true } },
    });
    FullNameRpcs.toLayer({
      // @ts-expect-error rpc success requires fullName, but handler selects only id.
      getUser: users.getUser,
    });
  });

  it("lets native RpcGroup reject operation result shape drift", () => {
    const users = domain.bind({
      getUser: {
        to: "listUsers",
        select: userSelect,
      },
      createUser: { select: userSelect },
    });
    Rpcs.toLayer({
      // @ts-expect-error listUsers returns an array, but getUser rpc declares an object.
      getUser: users.getUser,
      createUser: users.createUser,
    });
  });

  it("keeps operation Error failures in the RPC failure channel", async () => {
    const users = domain.bind({
      getUser: { select: userSelect },
    });

    const exit = await Effect.runPromiseExit(
      users.getUser({ id: "missing" }).pipe(Effect.provide(UserRepoLive)),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("composes domain-backed stream services with native RpcGroup.toLayer", async () => {
    const counters = streamGraph.bindSubscriptions({
      watchCounters: { select: counterSelect },
      renamedCounters: {
        to: "watchCounters",
        select: counterSelect,
      },
      failCounters: { select: counterSelect },
    });
    const Live = StreamRpcs.toLayer({
      watchCounters: counters.watchCounters,
      renamedCounters: (payload) => counters.renamedCounters({ start: payload.from }),
      failCounters: counters.failCounters,
    });

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(StreamRpcs);
      const direct = yield* Stream.runCollect(client.watchCounters({ start: 3 }));
      const renamed = yield* Stream.runCollect(client.renamedCounters({ from: 7 }));
      return { direct, renamed };
    });

    const { direct, renamed } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(Live))) as unknown as Effect.Effect<
        {
          readonly direct: ReadonlyArray<Record<string, Result.Result<number, unknown>>>;
          readonly renamed: ReadonlyArray<Record<string, Result.Result<number, unknown>>>;
        },
        unknown,
        never
      >,
    );

    expect(direct).toHaveLength(2);
    expect(Result.getOrThrow(direct[0].value)).toBe(3);
    expect(Result.getOrThrow(direct[0].doubled)).toBe(6);
    expect(Result.getOrThrow(direct[1].value)).toBe(4);
    expect(Result.getOrThrow(renamed[0].value)).toBe(7);
    expect(Result.getOrThrow(renamed[0].doubled)).toBe(14);
  });

  it("propagates domain stream failures through the RPC stream channel", async () => {
    const counters = streamGraph.bindSubscriptions({
      watchCounters: { select: counterSelect },
      renamedCounters: {
        to: "watchCounters",
        select: counterSelect,
      },
      failCounters: { select: counterSelect },
    });
    const Live = StreamRpcs.toLayer({
      watchCounters: counters.watchCounters,
      renamedCounters: (payload) => counters.renamedCounters({ start: payload.from }),
      failCounters: counters.failCounters,
    });

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(StreamRpcs);
      const seen: Array<Record<string, Result.Result<number, unknown>>> = [];
      const exit = yield* Stream.runForEach(client.failCounters(), (item) =>
        Effect.sync(() => {
          seen.push(item);
        }),
      ).pipe(Effect.exit);
      return { seen, exit };
    });

    const { seen, exit } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(Live))) as unknown as Effect.Effect<
        {
          readonly seen: Array<Record<string, Result.Result<number, unknown>>>;
          readonly exit: { readonly _tag: string };
        },
        never,
        never
      >,
    );

    expect(seen).toHaveLength(1);
    expect(Result.getOrThrow(seen[0].doubled)).toBe(2);
    expect(exit._tag).toBe("Failure");
  });

  it("keeps stream Error failures in the RPC stream failure channel", async () => {
    const counters = streamGraph.bindSubscriptions({
      failCountersWithError: { select: counterSelect },
    });
    const seen: Array<Record<string, Result.Result<number, unknown>>> = [];

    const exit = await Effect.runPromiseExit(
      Stream.runForEach(counters.failCountersWithError(), (item) =>
        Effect.sync(() => {
          seen.push(item);
        }),
      ),
    );

    expect(seen).toHaveLength(1);
    expect(Result.getOrThrow(seen[0].doubled)).toBe(2);
    expect(exit._tag).toBe("Failure");
  });
});
