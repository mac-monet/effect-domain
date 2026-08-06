import { Effect, type Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { WireTransport } from "./client.ts";

/**
 * The wire itself failed: network error, non-JSON body, non-2xx status.
 * Domain and gateway errors never surface here — they travel inside the
 * envelope and come back as their own types. `status` is set when an HTTP
 * response arrived at all.
 *
 * @since 0.4.0
 * @category errors
 */
export class TransportError extends Schema.TaggedErrorClass<TransportError>()("TransportError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

/**
 * The canonical HTTP transport for {@link client}: POST each dispatch
 * envelope as JSON to one endpoint and return the JSON body — the shape
 * `handleDispatch` produces on the other end. Backed by effect's
 * `HttpClient`, provided from `FetchHttpClient.layer` by default so the
 * returned transport is self-contained (browser, Bun, Node 18+, edge
 * runtimes). Pass `httpClient` to supply your own layer instead — for
 * middleware, custom fetch, or tests.
 *
 * Wire-level failures collapse into {@link TransportError}; subscriptions
 * are not supported (`subscribe` fails with a `TransportError` — put a
 * streaming transport in front of `client` when an app needs them).
 *
 * @since 0.4.0
 * @category constructors
 */
export const transportHttp = (
  url: string,
  options?: {
    readonly headers?: Record<string, string>;
    readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
  },
): WireTransport<TransportError> => {
  const httpClientLayer = options?.httpClient ?? FetchHttpClient.layer;
  const toTransportError = (error: unknown): TransportError => {
    const status =
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
    return new TransportError({
      message: error instanceof Error ? error.message : String(error),
      ...(status === undefined ? {} : { status }),
    });
  };
  return {
    execute: (request) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const httpRequest = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(options?.headers ?? {}),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJson(request),
        );
        const response = yield* httpClient.execute(httpRequest);
        const ok = yield* HttpClientResponse.filterStatusOk(response);
        return yield* ok.json;
      }).pipe(
        Effect.provide(httpClientLayer),
        Effect.catch((error) => Effect.fail(toTransportError(error))),
      ),
    subscribe: () =>
      Stream.fail(new TransportError({ message: "transportHttp does not support subscriptions" })),
  };
};
