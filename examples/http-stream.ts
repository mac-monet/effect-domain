import { Effect, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { domain, UserRepoLive } from "./domain.ts";

const userSelect = { id: true, fullName: true } as const;

export const Api = HttpApi.make("StreamExample").add(
  HttpApiGroup.make("Users").add(
    HttpApiEndpoint.get("watchUsers", "/users/stream/:start", {
      params: { start: Schema.NumberFromString },
      success: domain.responseSchema("watchUsers", userSelect),
    }),
  ),
);

const userStreams = domain.bindSubscriptions({
  watchUsers: { select: userSelect },
});
const watchUsersSuccess = domain.responseSchema("watchUsers", userSelect);

const watchUsersRoute = HttpRouter.route(
  "GET",
  "/users/stream/:start",
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ start: Schema.NumberFromString }),
    );
    const body = userStreams.watchUsers({ start: params.start }).pipe(
      Stream.mapEffect((item) => Schema.encodeUnknownEffect(watchUsersSuccess)(item)),
      Stream.map((item) => `${JSON.stringify(item)}\n`),
      Stream.encodeText,
    );

    return HttpServerResponse.stream(body, {
      contentType: "application/x-ndjson",
    });
  }),
);

export const AppLive = HttpRouter.addAll([watchUsersRoute]).pipe(
  HttpRouter.provideRequest(UserRepoLive),
);

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
});
