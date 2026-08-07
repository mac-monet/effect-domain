import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation, subscription } from "../src/index.ts";

const User = node("DefectUser", Schema.Struct({ id: Schema.String }), {});

async function expectDies(effect: Effect.Effect<unknown, never, never>): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
  }
}

describe("domain invariant violations are defects", () => {
  it("dies when a resolver returns nullish for a non-nullable root", async () => {
    const domain = Domain.make({
      get: operation({
        type: User,
        resolve: () => Effect.succeed(null as never),
      }),
    });
    await expectDies(domain.execute({ name: "get", select: { id: true } }));
  });

  it("dies when a resolver returns a non-array for an array root", async () => {
    const domain = Domain.make({
      list: operation({
        type: Schema.Array(User),
        resolve: () => Effect.succeed({ id: "1" } as never),
      }),
    });
    await expectDies(domain.execute({ name: "list", select: { id: true } }));
  });

  it("dies when a selection is forced onto an opaque root past the type system", async () => {
    const domain = Domain.make({
      count: operation({
        type: Schema.Number,
        resolve: () => Effect.succeed(1),
      }),
    });
    await expectDies(domain.execute({ name: "count", select: { value: true } } as never));
  });

  it("dies when an unknown operation name is forced past the type system", async () => {
    const domain = Domain.make({
      get: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    await expectDies(domain.execute({ name: "missing" } as never));
  });

  it("dies when an unknown subscription name is forced past the type system", async () => {
    const domain = Domain.make({
      onUser: subscription({
        type: User,
        resolve: () => Stream.succeed({ id: "1" }),
      }),
    });
    await expectDies(
      Stream.runCollect(domain.subscribe({ name: "missing" } as never)) as Effect.Effect<
        unknown,
        never,
        never
      >,
    );
  });

  it("keeps the typed error channel exactly the operation's E", () => {
    class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {}) {}
    const domain = Domain.make({
      get: operation({
        type: User,
        resolve: (): Effect.Effect<{ id: string }, NotFound> => Effect.fail(new NotFound()),
      }),
    });
    const effect = domain.execute({ name: "get", select: { id: true } });
    // Compile-time assertion: E is NotFound, with no untyped Error mixed in.
    const _typed: Effect.Effect<unknown, NotFound, never> = effect;
    void _typed;
  });
});
