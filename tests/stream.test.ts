import { Effect, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, subscription } from "../src/index.ts";

describe("Unit 6: stream operations", () => {
  it("subscription stream emits walked result trees", async () => {
    const Counter = node("Counter", Schema.Struct({ value: Schema.Number }), {
      doubled: field({
        type: Schema.Number,
        resolve: ({ parent }) => Effect.succeed(parent.value * 2),
      }),
    });

    const g = Domain.make({
      onCount: subscription({
        type: Counter,
        resolve: () => Stream.make({ value: 1 }, { value: 2 }, { value: 3 }),
      }),
    });

    const results = await Effect.runPromise(
      Stream.runCollect(
        g.subscribe("onCount", {
          select: { value: true, doubled: true },
        }),
      ),
    );

    expect(results).toHaveLength(3);
    expect(Result.getOrThrow(results[0].value)).toBe(1);
    expect(Result.getOrThrow(results[0].doubled)).toBe(2);
    expect(Result.getOrThrow(results[1].value)).toBe(2);
    expect(Result.getOrThrow(results[1].doubled)).toBe(4);
    expect(Result.getOrThrow(results[2].value)).toBe(3);
    expect(Result.getOrThrow(results[2].doubled)).toBe(6);
  });

  it("subscription with args passes args to resolver", async () => {
    const Message = node("Message", Schema.Struct({ text: Schema.String }), {});

    const g = Domain.make({
      onMessage: subscription({
        type: Message,
        args: Schema.Struct({ channel: Schema.String }),
        resolve: ({ args }) => Stream.make({ text: `msg from ${args.channel}` }),
      }),
    });

    const results = await Effect.runPromise(
      Stream.runCollect(
        g.subscribe("onMessage", {
          args: { channel: "general" },
          select: { text: true },
        }),
      ),
    );

    expect(results).toHaveLength(1);
    expect(Result.getOrThrow(results[0].text)).toBe("msg from general");
  });

  it("stream error mid-emission propagates to consumer", async () => {
    const Item = node("StreamItem", Schema.Struct({ id: Schema.String }), {});

    const g = Domain.make({
      onItem: subscription({
        type: Item,
        resolve: () =>
          Stream.concat(Stream.make({ id: "1" }, { id: "2" }), Stream.fail("stream-error")),
      }),
    });

    const collected: Array<Record<string, unknown>> = [];
    const exit = await Effect.runPromiseExit(
      Stream.runForEach(g.subscribe("onItem", { select: { id: true } }), (item) =>
        Effect.sync(() => {
          collected.push(item);
        }),
      ),
    );

    expect(collected).toHaveLength(2);
    expect(exit._tag).toBe("Failure");
  });
});
