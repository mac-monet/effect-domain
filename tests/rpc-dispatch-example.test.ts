import { Effect, Exit, Option, Schema, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { UserNotFound } from "../examples/domain.ts";
import { makeDomainRpc, rpc, RpcLive } from "../examples/rpc-dispatch.ts";
import { ArgsParseError, Domain, operation, UnknownOperation } from "../src/index.ts";

const withClient = <A, E>(f: (client: ReturnType<typeof rpc.clientFrom>) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.flatMap(Effect.map(RpcTest.makeClient(rpc.group), rpc.clientFrom), f).pipe(
      Effect.provide(RpcLive),
    ),
  );

describe("Examples: dynamic typed RPC adapter", () => {
  it("round-trips a typed resolver error through the declared schema", async () => {
    const exit = await Effect.runPromiseExit(
      withClient((client) =>
        client.execute({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
      ),
    );
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);
    expect(error).toBeInstanceOf(UserNotFound);
    expect(error).toMatchObject({ _tag: "UserNotFound", id: "missing" });
  });

  it("invalid args and unknown names surface as typed gateway failures", async () => {
    const badArgs = await Effect.runPromiseExit(
      withClient((client) =>
        // @ts-expect-error wrong args shape
        client.execute({ name: "getUser", args: { nope: true }, select: { id: true } }),
      ),
    );
    expect(Exit.findErrorOption(badArgs).pipe(Option.getOrThrow)).toBeInstanceOf(ArgsParseError);

    const badName = await Effect.runPromiseExit(
      withClient((client) =>
        // @ts-expect-error unknown operation
        client.execute({ name: "nope", select: { id: true } }),
      ),
    );
    expect(Exit.findErrorOption(badName).pipe(Option.getOrThrow)).toBeInstanceOf(UnknownOperation);
  });

  it("subscribes through DomainSubscribe with live decoded items", async () => {
    const users = await Effect.runPromise(
      withClient((client) =>
        Stream.runCollect(
          client.subscribe({
            name: "watchUsers",
            args: { start: 10 },
            select: { id: true, fullName: true },
          }),
        ),
      ),
    );
    expect(users).toHaveLength(2);
    expect(users[0].id).toBe("10");
    expect(users[0].fullName).toBe("Stream One");
    expect(users[1].fullName).toBe("Stream Two");
  });

  it("rejects invalid selections at compile time", () => {
    const program = withClient((client) =>
      // @ts-expect-error bogus is not a selectable field
      client.execute({ name: "getUser", args: { id: "1" }, select: { bogus: true } }),
    );
    expect(program).toBeDefined();
  });

  it("rejects domains with undeclared error schemas at compile time", () => {
    class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", { message: Schema.String }) {}
    const incomplete = Domain.make({
      explode: operation({
        type: Schema.String,
        resolve: () => Effect.fail(new Boom({ message: "x" })) as Effect.Effect<string, Boom>,
      }),
    });
    // @ts-expect-error explode fails with Boom but declares no error schema
    makeDomainRpc(incomplete);
    expect(true).toBe(true);
  });
});
