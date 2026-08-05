// The domain gateway behind the Foldkit app: the whole public API is one
// endpoint. POST /rpc receives a dispatch envelope ({ name, args, select }),
// and `domain.handleDispatch` validates it, executes, and encodes the Result
// with the domain's own wire codec — declared errors (UserNotFound) travel
// inside the envelope, so this handler's error channel is `never` and the
// typed client on the other end recovers them as class instances.
//
// Run with: bun run server.ts
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { domain, UserRepoLive } from "../domain.ts";

const Routes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/rpc",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = ((yield* request.json) ?? {}) as {
        readonly name?: string;
        readonly args?: unknown;
        readonly select?: unknown;
      };
      const encoded = yield* domain.handleDispatch({
        name: body.name ?? "",
        args: body.args,
        select: body.select,
      });
      return yield* HttpServerResponse.json(encoded);
    }),
  ),
]);

const { handler } = HttpRouter.toWebHandler(Routes.pipe(HttpRouter.provideRequest(UserRepoLive)), {
  disableLogger: true,
});

Bun.serve({ port: 3001, fetch: (request) => handler(request) });
console.log("domain gateway on http://localhost:3001/rpc");
