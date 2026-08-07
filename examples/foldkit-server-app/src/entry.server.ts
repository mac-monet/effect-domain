// The application's entire boundary: one Web Request in, one ServerEntryResult
// out. GETs render the route; the create form's POST executes the domain
// operation and redirects. Nothing else exists — no /rpc, no wire client,
// no hydration. The domain is right here, so every screen's data is a direct
// `domain.execute` with the same selections `responseSchema` derived the
// Model's schemas from: the page you receive is the projection, serialized
// as HTML instead of JSON.
import { Effect, Match as M, Option } from "effect";
import * as Server from "foldkit/experimental/server";
import { fromString as urlFromString } from "foldkit/url";

import { domain } from "../../domain.ts";
import { Flags, init, view } from "./main";
import { detailSelect, summarySelect } from "./projection";
import { AppRoute, urlToAppRoute, userRouter } from "./route";
import { runtime } from "./server-runtime";

const emptyFlags: Flags = { users: null, user: null };

const flagsForRoute = (route: AppRoute) =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () =>
        domain
          .execute({ name: "listUsers", select: summarySelect })
          .pipe(Effect.map((users) => ({ ...emptyFlags, users }))),
      // UserNotFound leaves `user` null; the view renders the not-found card
      // and the page goes out as a 404.
      User: ({ id }) =>
        domain.execute({ name: "getUser", args: { id }, select: detailSelect }).pipe(
          Effect.map((user) => ({ ...emptyFlags, user })),
          Effect.catch(() => Effect.succeed(emptyFlags)),
        ),
      NotFound: () => Effect.succeed(emptyFlags),
    }),
  );

const statusForPage = (route: AppRoute, flags: Flags): number =>
  route._tag === "NotFound" || (route._tag === "User" && flags.user === null) ? 404 : 200;

const redirect = (location: string): Server.ServerEntryResult =>
  Server.Responded(new Response(null, { status: 303, headers: { location } }));

// POST /users from the native create form: run the operation, then redirect
// so the browser lands on a normal GET render of the new user.
const handleCreate = (request: Request) =>
  Effect.gen(function* () {
    const form = yield* Effect.promise(() => request.formData());
    const firstName = String(form.get("firstName") ?? "").trim();
    const lastName = String(form.get("lastName") ?? "").trim();
    if (firstName === "" || lastName === "") {
      return redirect("/");
    }
    const user = yield* domain.execute({
      name: "createUser",
      args: { firstName, lastName },
      select: summarySelect,
    });
    return redirect(userRouter({ id: user.id }));
  });

const renderRoute = (requestUrl: string) =>
  Effect.gen(function* () {
    const url = Option.getOrThrowWith(
      urlFromString(requestUrl),
      () => new Error(`Cannot render the invalid URL "${requestUrl}".`),
    );
    const route = urlToAppRoute(url);
    const flags = yield* flagsForRoute(route);
    const application = yield* Server.renderToString(
      { Flags, routing: {}, init, view },
      // Static markup only: no hydration contract, so no root stamp and no
      // embedded flags payload — nothing in the browser will ever replay it.
      { url: requestUrl, flags, isHydratable: false },
    );
    return Server.Rendered(application, {
      status: statusForPage(route, flags),
      headers: { "cache-control": "no-store" },
    });
  });

export const renderPage = (request: Request): Promise<Server.ServerEntryResult> =>
  runtime.runPromise(
    request.method === "POST" && new URL(request.url).pathname === "/users"
      ? handleCreate(request)
      : renderRoute(request.url),
  );
