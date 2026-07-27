import { Effect, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { domain, UserNotFound, UserRepoLive } from "./domain.ts";
import {
  ArgsParseError,
  Domain,
  SelectionParseError,
  UnknownOperation,
  WrongOperationKind,
} from "../src/index.ts";

// GraphQL-like dynamic dispatch over plain JSON. Clients choose an operation by
// URL and send its args plus a runtime selection:
//
//   POST /getUser
//   { "args": { "id": "1" }, "select": { "id": true, "fullName": true } }
//
// Fixed-contract transports should usually use domain.bind(...). Dynamic
// gateways use domain.dispatch(...) so args and selections are decoded at the
// boundary before the domain operation runs.
function operationRoute(name: string) {
  return HttpRouter.route(
    "POST",
    `/${name}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json) as { readonly args?: unknown; readonly select?: unknown };
      const handled = domain
        .dispatch({ name, args: body.args, select: body.select })
        .pipe(Domain.orFail);

      return yield* Effect.matchEffect(handled, {
        onFailure: operationErrorResponse,
        onSuccess: (result) =>
          Result.isFailure(result)
            ? boundaryErrorResponse(result.failure)
            : HttpServerResponse.json(result.success),
      });
    }),
  );
}

function boundaryErrorResponse(
  error: UnknownOperation | ArgsParseError | SelectionParseError | WrongOperationKind,
) {
  const status = error instanceof UnknownOperation ? 404 : 400;
  return HttpServerResponse.json(error, { status });
}

function operationErrorResponse(error: unknown) {
  if (error instanceof UserNotFound) {
    return HttpServerResponse.json(error, { status: 404 });
  }
  return HttpServerResponse.json({ _tag: "OperationError", cause: String(error) }, { status: 400 });
}

const Routes = HttpRouter.addAll(domain.operationNames().map(operationRoute));

export const AppLive = Routes.pipe(HttpRouter.provideRequest(UserRepoLive));

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
});
