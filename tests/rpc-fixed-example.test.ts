import { Effect, Exit, Result } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { UserNotFound } from "../examples/domain.ts";
import { RpcLive, Rpcs } from "../examples/rpc-fixed.ts";

describe("Examples: RPC via domain.bind", () => {
  it("client roundtrips getUser and createUser", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(Rpcs);
      const user = yield* client.getUser({ id: "1" });
      const created = yield* client.createUser({
        firstName: "Evelyn",
        lastName: "Evans",
      });
      return { user, created };
    });

    const { user, created } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(RpcLive))) as unknown as Effect.Effect<
        {
          readonly user: Record<string, Result.Result<string, unknown>>;
          readonly created: Record<string, Result.Result<string, unknown>>;
        },
        never,
        never
      >,
    );

    expect(Result.getOrThrow(user.id)).toBe("1");
    expect(Result.getOrThrow(user.fullName)).toBe("Alice Anderson");
    expect(Result.getOrThrow(created.fullName)).toBe("Evelyn Evans");
  });

  it("client receives the typed operation error", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(Rpcs);
      return yield* client.getUser({ id: "missing" });
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(program.pipe(Effect.provide(RpcLive))) as Effect.Effect<
        unknown,
        UserNotFound,
        never
      >,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.findErrorOption(exit);
    expect(error._tag).toBe("Some");
    if (error._tag === "Some") {
      expect(error.value).toBeInstanceOf(UserNotFound);
      expect(error.value).toMatchObject({
        _tag: "UserNotFound",
        id: "missing",
        message: "User missing not found",
      });
    }
  });
});
