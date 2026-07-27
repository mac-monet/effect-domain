import { Effect, Layer, Result, Schema, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserRepoLive } from "../examples/domain.ts";
import { Domain, node, operation, subscription } from "../src/index.ts";

const userSelect = { id: true, fullName: true } as const;

const Api = HttpApi.make("Test").add(
  HttpApiGroup.make("Users").add(
    HttpApiEndpoint.get("getUser", "/users/:id", {
      params: { id: Schema.String },
      success: domain.responseSchema("getUser", userSelect),
      error: Schema.Unknown,
    }),
    HttpApiEndpoint.post("createUser", "/users", {
      payload: domain.argsSchema("createUser"),
      success: domain.responseSchema("createUser", userSelect),
      error: Schema.Unknown,
    }),
    HttpApiEndpoint.get("publicUser", "/public/users/:id", {
      params: { id: Schema.String },
      success: domain.responseSchema("getUser", userSelect),
      error: Schema.Unknown,
    }),
  ),
);

const PingApi = HttpApi.make("PingApi").add(
  HttpApiGroup.make("Ping").add(
    HttpApiEndpoint.get("ping", "/ping", {
      success: Schema.String,
      error: Schema.Unknown,
    }),
  ),
);

const FullNameApi = HttpApi.make("FullNameApi").add(
  HttpApiGroup.make("Users").add(
    HttpApiEndpoint.get("getUser", "/users/:id", {
      params: { id: Schema.String },
      success: domain.responseSchema("getUser", { fullName: true }),
      error: Schema.Unknown,
    }),
  ),
);

const pingGraph = Domain.make({
  ping: operation({
    type: Schema.String,
    resolve: () => Effect.succeed("pong"),
  }),
});

const Counter = node("HttpCounter", Schema.Struct({ value: Schema.Number }), (f) => ({
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

describe("Domain binding", () => {
  it("exposes domain schemas in HttpApiEndpoint declarations", () => {
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

  it("composes domain-backed operation services with native HttpApiBuilder.group", () => {
    const users = domain.bind({
      getUser: { select: userSelect },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    const UsersLive = HttpApiBuilder.group(Api, "Users", (handlers) =>
      handlers
        .handle("getUser", ({ params }) => users.getUser({ id: params.id }))
        .handle("createUser", ({ payload }) => users.createUser(payload))
        .handle("publicUser", ({ params }) => users.publicUser({ id: params.id })),
    );

    expect(UsersLive).toBeDefined();
  });

  it("serves domain-backed HttpApi requests", async () => {
    const users = domain.bind({
      getUser: { select: userSelect },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    const UsersLive = HttpApiBuilder.group(Api, "Users", (handlers) =>
      handlers
        .handle("getUser", ({ params }) => users.getUser({ id: params.id }))
        .handle("createUser", ({ payload }) => users.createUser(payload))
        .handle("publicUser", ({ params }) => users.publicUser({ id: params.id })),
    );
    const AppLive = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(UsersLive),
      Layer.provide(UserRepoLive),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(AppLive as never, {
      disableLogger: true,
    });

    try {
      const response = await (handler as (request: Request) => Promise<Response>)(
        new Request("http://localhost/users/1"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<
        string,
        { readonly _tag: string; readonly success: string }
      >;
      expect(body.id.success).toBe("1");
      expect(body.fullName.success).toBe("Alice Anderson");
    } finally {
      await dispose();
    }
  });

  it("supports scalar root operations without a selection", () => {
    const pings = pingGraph.bind({
      ping: {},
    });
    const PingLive = HttpApiBuilder.group(PingApi, "Ping", (handlers) =>
      handlers.handle("ping", () => pings.ping()),
    );

    expect(PingLive).toBeDefined();
    expect(pingGraph.responseSchema("ping")).toBeDefined();
  });

  it("requires args mappers for operations with required args", () => {
    const users = domain.bind({
      getUser: { select: userSelect },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    HttpApiBuilder.group(Api, "Users", (handlers) =>
      handlers
        .handle(
          "getUser",
          // @ts-expect-error getUser requires domain args.
          () => users.getUser(),
        )
        .handle("createUser", ({ payload }) => users.createUser(payload))
        .handle("publicUser", ({ params }) => users.publicUser({ id: params.id })),
    );
  });

  it("requires every endpoint in the group to be handled", () => {
    const users = domain.bind({
      getUser: { select: userSelect },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    HttpApiBuilder.group(Api, "Users", (handlers) =>
      // @ts-expect-error createUser and publicUser are still unhandled by native HttpApiBuilder.
      handlers.handle("getUser", ({ params }) => users.getUser({ id: params.id })),
    );
  });

  it("lets native HttpApiBuilder reject success schema drift", () => {
    const users = domain.bind({
      getUser: { select: { id: true } },
    });
    HttpApiBuilder.group(FullNameApi, "Users", (handlers) =>
      handlers.handle(
        "getUser",
        // @ts-expect-error endpoint success requires fullName, but handler selects only id.
        ({ params }) => users.getUser({ id: params.id }),
      ),
    );
  });

  it("lets native HttpApiBuilder reject operation result shape drift", () => {
    const users = domain.bind({
      getUser: {
        to: "listUsers",
        select: userSelect,
      },
      createUser: { select: userSelect },
      publicUser: { to: "getUser", select: userSelect },
    });
    HttpApiBuilder.group(Api, "Users", (handlers) =>
      handlers
        .handle(
          "getUser",
          // @ts-expect-error listUsers returns an array, but getUser endpoint declares an object.
          () => users.getUser(),
        )
        .handle("createUser", ({ payload }) => users.createUser(payload))
        .handle("publicUser", ({ params }) => users.publicUser({ id: params.id })),
    );
  });

  it("keeps operation Error failures in the HTTP failure channel", async () => {
    const users = domain.bind({
      getUser: { select: userSelect },
    });

    const exit = await Effect.runPromiseExit(
      users.getUser({ id: "missing" }).pipe(Effect.provide(UserRepoLive)),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("returns domain-backed streams for HTTP response encoders to consume", async () => {
    const counters = streamGraph.bindSubscriptions({
      watchCounters: { select: counterSelect },
      renamedCounters: {
        to: "watchCounters",
        select: counterSelect,
      },
    });

    const direct = await Effect.runPromise(Stream.runCollect(counters.watchCounters({ start: 3 })));
    const projected = await Effect.runPromise(
      Stream.runCollect(counters.renamedCounters({ start: 7 })),
    );

    expect(direct).toHaveLength(2);
    expect(Result.getOrThrow(direct[0].value)).toBe(3);
    expect(Result.getOrThrow(direct[0].doubled)).toBe(6);
    expect(Result.getOrThrow(direct[1].value)).toBe(4);
    expect(Result.getOrThrow(projected[0].value)).toBe(7);
    expect(Result.getOrThrow(projected[0].doubled)).toBe(14);
  });

  it("propagates domain stream failures through the HTTP stream channel", async () => {
    const counters = streamGraph.bindSubscriptions({
      failCounters: { select: counterSelect },
    });
    const seen: Array<Record<string, Result.Result<number, unknown>>> = [];

    const exit = await Effect.runPromiseExit(
      Stream.runForEach(counters.failCounters(), (item) =>
        Effect.sync(() => {
          seen.push(item);
        }),
      ),
    );

    expect(seen).toHaveLength(1);
    expect(Result.getOrThrow(seen[0].doubled)).toBe(2);
    expect(exit._tag).toBe("Failure");
  });

  it("keeps stream Error failures in the HTTP stream failure channel", async () => {
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
