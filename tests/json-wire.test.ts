import { Effect, Exit, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, field, node, operation } from "../src/index.ts";

const Payload = Schema.Struct({
  at: Schema.Date,
  url: Schema.URL,
  count: Schema.BigInt,
});

const Output = Schema.Tuple([Schema.Date, Schema.URL, Schema.BigInt]);

class WireBoom extends Schema.TaggedError<WireBoom>()("WireBoom", {
  at: Schema.Date,
  count: Schema.BigInt,
}) {}

const Item = node("JsonWireItem", Schema.Struct({ id: Schema.String }), {
  formatted: field({
    type: Schema.String,
    args: Schema.Struct({ at: Schema.Date, count: Schema.BigInt }),
    resolve: ({ args }) => Effect.succeed(`${args.at.toISOString()}:${args.count}`),
  }),
});

const domain = Domain.make({
  echo: operation({
    args: Payload,
    type: Output,
    resolve: ({ args }) => Effect.succeed([args.at, args.url, args.count] as const),
  }),
  fail: operation({
    type: Schema.String,
    error: WireBoom,
    resolve: () =>
      Effect.fail(new WireBoom({ at: new Date("2026-08-21T00:00:00.000Z"), count: 42n })),
  }),
  item: operation({
    type: Item,
    resolve: () => Effect.succeed({ id: "item-1" }),
  }),
});

const jsonTransport = {
  execute: (request: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const wireRequest = JSON.parse(JSON.stringify(request));
        const response = await Effect.runPromise(domain.handleDispatch(wireRequest));
        return JSON.parse(JSON.stringify(response));
      },
      catch: (cause) => cause,
    }),
  subscribe: () => Stream.empty,
};

const client = Domain.client(domain, jsonTransport);

describe("canonical JSON wire codec", () => {
  it("round-trips transformed args and success values through plain JSON", async () => {
    const input = {
      at: new Date("2026-08-21T00:00:00.000Z"),
      url: new URL("https://example.com/path?q=1"),
      count: 9007199254740993n,
    };

    const output = await Effect.runPromise(client.execute({ name: "echo", args: input }));

    expect(output).toEqual([input.at, input.url, input.count]);
    expect(output[0]).toBeInstanceOf(Date);
    expect(output[1]).toBeInstanceOf(URL);
    expect(typeof output[2]).toBe("bigint");
  });

  it("round-trips transformed failures through plain JSON", async () => {
    const exit = await Effect.runPromiseExit(client.execute({ name: "fail" }));
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);

    expect(error).toBeInstanceOf(WireBoom);
    expect((error as WireBoom).at).toBeInstanceOf(Date);
    expect((error as WireBoom).count).toBe(42n);
  });

  it("round-trips transformed computed-field args through plain JSON", async () => {
    const output = await Effect.runPromise(
      client.execute({
        name: "item",
        select: {
          formatted: {
            args: { at: new Date("2026-08-21T00:00:00.000Z"), count: 42n },
          },
        },
      }),
    );

    expect(output.formatted).toBe("2026-08-21T00:00:00.000Z:42");
  });
});
