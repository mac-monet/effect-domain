import { Effect, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { RpcLive, Rpcs } from "../examples/rpc-stream.ts";

describe("Examples: RPC streams via domain.bindSubscriptions", () => {
  it("client receives projected stream items", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(Rpcs);
      return yield* Stream.runCollect(client.watchUsers({ start: 10 }));
    });

    const users = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(RpcLive))) as unknown as Effect.Effect<
        ReadonlyArray<Record<string, string>>,
        never,
        never
      >,
    );

    expect(users).toHaveLength(2);
    expect(users[0].id).toBe("10");
    expect(users[0].fullName).toBe("Stream One");
    expect(users[1].id).toBe("11");
    expect(users[1].fullName).toBe("Stream Two");
  });
});
