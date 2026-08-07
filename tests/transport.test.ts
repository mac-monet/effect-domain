import { Effect, Exit, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserNotFound, UserRepoLive } from "../examples/domain.ts";
import { Domain } from "../src/index.ts";

const liveDomain = domain.provide(UserRepoLive);

// A fetch that hands the envelope straight to the real gateway: the entire
// HTTP transport path (request building, JSON bodies, status filtering,
// response decode) runs for real, with the network swapped out.
const gatewayFetch: typeof fetch = async (input, init) => {
  const body = await new Request(input, { ...init, duplex: "half" } as RequestInit).text();
  const envelope = JSON.parse(body) as { name: string };
  const encoded = await Effect.runPromise(liveDomain.handleDispatch(envelope));
  return Response.json(encoded);
};

const withFetch = (fetchImpl: typeof fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchImpl)));

describe("transportHttp", () => {
  const client = Domain.client(
    domain,
    Domain.transportHttp("http://test/rpc", { httpClient: withFetch(gatewayFetch) }),
  );

  it("round-trips a typed success over the fetch path", async () => {
    const user = await Effect.runPromise(
      client.execute({ name: "getUser", args: { id: "1" }, select: { id: true, fullName: true } }),
    );
    expect(user.id).toBe("1");
    expect(user.fullName).toBe("Alice Anderson");
  });

  it("unwraps a declared error carried inside the envelope", async () => {
    const exit = await Effect.runPromiseExit(
      client.execute({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
    );
    expect(Exit.findErrorOption(exit).pipe(Option.getOrThrow)).toBeInstanceOf(UserNotFound);
  });

  it("maps a non-2xx response to TransportError with the status", async () => {
    const failing = Domain.client(
      domain,
      Domain.transportHttp("http://test/rpc", {
        httpClient: withFetch(async () => new Response("boom", { status: 502 })),
      }),
    );
    const exit = await Effect.runPromiseExit(
      failing.execute({ name: "getUser", args: { id: "1" }, select: { id: true } }),
    );
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);
    expect(error).toBeInstanceOf(Domain.TransportError);
    expect((error as Domain.TransportError).status).toBe(502);
  });

  it("maps a network failure to TransportError without a status", async () => {
    const offline = Domain.client(
      domain,
      Domain.transportHttp("http://test/rpc", {
        httpClient: withFetch(async () => {
          throw new TypeError("network down");
        }),
      }),
    );
    const exit = await Effect.runPromiseExit(
      offline.execute({ name: "getUser", args: { id: "1" }, select: { id: true } }),
    );
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);
    expect(error).toBeInstanceOf(Domain.TransportError);
    expect((error as Domain.TransportError).status).toBeUndefined();
  });

  it("fails subscriptions with a TransportError", async () => {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        client.subscribe({ name: "watchUsers", args: { start: 1 }, select: { id: true } }),
      ),
    );
    const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow);
    expect(error).toBeInstanceOf(Domain.TransportError);
  });
});
