import { Effect, Result, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { domain, UserNotFound, UserRepoLive } from "./domain.ts";
import { OperationError, type Selection, UnknownOperation } from "../src/index.ts";

// GraphQL-like dynamic dispatch over plain JSON. Clients choose an operation by
// URL and send its args plus a runtime selection:
//
//   POST /getUser
//   { "args": { "id": "1" }, "select": { "id": true, "fullName": true } }
//
// Every response body is the schema-encoded dispatch Result — the same wire
// envelope the RPC adapter uses — so a typed client can decode it with
// `domain.dispatchResultSchemaDynamic(name, select)` and recover declared
// errors (e.g. UserNotFound) as class instances. The HTTP status is derived
// from the failure, not the other way around.
const statusFor = (failure: unknown): number =>
  failure instanceof UnknownOperation ||
  (failure instanceof OperationError && failure.cause instanceof UserNotFound)
    ? 404
    : 400;

function operationRoute(name: string) {
  return HttpRouter.route(
    "POST",
    `/${name}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json) as { readonly args?: unknown; readonly select?: unknown };
      const result = yield* domain
        .prepareDispatch({ name, args: body.args, select: body.select })
        .pipe(
          Effect.matchEffect({
            onFailure: (gatewayError) => Effect.succeed(Result.fail(gatewayError)),
            onSuccess: (prepared) => prepared.execute(),
          }),
        );
      const encoded = yield* Schema.encodeEffect(
        domain.dispatchResultSchemaDynamic(name, body.select as Selection | undefined),
      )(result);
      return yield* HttpServerResponse.json(encoded, {
        status: Result.isFailure(result) ? statusFor(result.failure) : 200,
      });
    }),
  );
}

const Routes = HttpRouter.addAll(domain.operationNames().map(operationRoute));

export const AppLive = Routes.pipe(HttpRouter.provideRequest(UserRepoLive));

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
});
