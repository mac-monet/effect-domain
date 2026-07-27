import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";
import { domain, UserNotFound, UserRepoLive } from "./domain.ts";

const userSummarySelect = { id: true, fullName: true } as const;
const userDetailSelect = {
  id: true,
  fullName: true,
  profile: { select: { location: true } },
} as const;
const userCardSelect = {
  id: true,
  greeting: { args: { salutation: "Dr." } },
  profile: { select: { bio: true } },
} as const;
const UserNotFoundResponse = UserNotFound.pipe(HttpApiSchema.status(404));

export const Api = HttpApi.make("ApiExample").add(
  HttpApiGroup.make("Users").add(
    HttpApiEndpoint.get("getUser", "/users/:id", {
      params: { id: Schema.String },
      success: domain.responseSchema("getUser", userDetailSelect),
      error: UserNotFoundResponse,
    }),
    HttpApiEndpoint.get("getUserCard", "/users/:id/card", {
      params: { id: Schema.String },
      success: domain.responseSchema("getUser", userCardSelect),
      error: UserNotFoundResponse,
    }),
    HttpApiEndpoint.post("createUser", "/users", {
      payload: domain.argsSchema("createUser"),
      success: domain.responseSchema("createUser", userSummarySelect),
    }),
  ),
);

const users = domain.bind({
  getUser: { select: userDetailSelect },
  getUserCard: { to: "getUser", select: userCardSelect },
  createUser: { select: userSummarySelect },
});

export const UsersLive = HttpApiBuilder.group(Api, "Users", (handlers) =>
  handlers
    .handle("getUser", ({ params }) => users.getUser({ id: params.id }))
    .handle("getUserCard", ({ params }) => users.getUserCard({ id: params.id }))
    .handle("createUser", ({ payload }) => users.createUser(payload)),
);

export const AppLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(UsersLive),
  HttpRouter.provideRequest(UserRepoLive),
  Layer.provide(HttpServer.layerServices),
);

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(AppLive));
