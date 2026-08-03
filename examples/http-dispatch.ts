import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { domain, UserRepoLive } from "./domain.ts";

// GraphQL-like dynamic dispatch over plain JSON. Clients choose an operation by
// URL and send its args plus a runtime selection:
//
//   POST /getUser
//   { "args": { "id": "1" }, "select": { "id": true, "fullName": true } }
//
// `domain.handleDispatch` is the whole server pipeline: validate the envelope,
// execute, and encode the dispatch Result with the domain's own wire codec.
// The body is `{ _tag: "Success", success } | { _tag: "Failure", failure }` —
// the same envelope the RPC adapter uses — so a typed client can decode it
// with `domain.dispatchResultSchemaDynamic(name, select)` and recover declared
// errors (e.g. UserNotFound) as class instances. HTTP status is policy, so it
// stays here in the adapter, read off the encoded envelope.
const statusFor = (encoded: unknown): number => {
  const wire = encoded as {
    readonly _tag: string;
    readonly failure?: { readonly _tag?: string; readonly cause?: { readonly _tag?: string } };
  };
  if (wire._tag === "Success") return 200;
  return wire.failure?._tag === "UnknownOperation" || wire.failure?.cause?._tag === "UserNotFound"
    ? 404
    : 400;
};

function operationRoute(name: string) {
  return HttpRouter.route(
    "POST",
    `/${name}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json) as { readonly args?: unknown; readonly select?: unknown };
      const encoded = yield* domain.handleDispatch({
        name,
        args: body.args,
        select: body.select,
      });
      return yield* HttpServerResponse.json(encoded, { status: statusFor(encoded) });
    }),
  );
}

const Routes = HttpRouter.addAll(domain.operationNames().map(operationRoute));

export const AppLive = Routes.pipe(HttpRouter.provideRequest(UserRepoLive));

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
});
