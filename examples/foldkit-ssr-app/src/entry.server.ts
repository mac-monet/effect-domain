// The application's server boundary, in the shape foldkit's SSR hosts expect:
// one Web Request in, one ServerEntryResult out.
//
// The interesting part is where Flags come from. The server fills the same
// AppClient seam the browser fills — but with the in-process
// `Domain.client(domain)` instead of the HTTP wire client — and then runs
// the very same `listUsers` / `getUser` effects the browser's Commands run.
// Same selections, same wire-codec round-trip (encode → decode in memory),
// same typed results; no HTTP hop. The resulting projection goes into Flags,
// is encoded by `responseSchema`'s wire codec into the HTML payload, and the
// hydrating browser decodes it with the same schema object and runs the same
// `init`. Server HTML and browser state cannot disagree: both are
// projections of one selection.
import { Effect, Layer, Match as M, Option } from "effect";
import * as Server from "foldkit/experimental/server";
import { fromString as urlFromString } from "foldkit/url";

import { Domain } from "../../../src/index.ts";
import { domain } from "../../domain.ts";
import { AppClient, type AppClientShape, getUser, listUsers } from "./domain-client";
import { Flags, init, view } from "./main";
import { AppRoute, urlToAppRoute } from "./route";
import { runtime } from "./server-runtime";

// The in-process client still needs UserRepo when a call runs; the shared
// server runtime supplies it to every render. The tag's type is written from
// the HTTP client and cannot express that leftover requirement — the cast
// erases it, the runtime satisfies it.
const AppClientInProcess = Layer.succeed(AppClient)(
  Domain.client(domain) as unknown as AppClientShape,
);

const emptyFlags: Flags = { preloadedUsers: null, preloadedUser: null };

const flagsForRoute = (route: AppRoute) =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () => listUsers.pipe(Effect.map((users) => ({ ...emptyFlags, preloadedUsers: users }))),
      // An unknown id renders as a 404 with nothing preloaded; the client's
      // own LoadUser then surfaces the UserNotFound error the normal way.
      // Only that error means "nothing to preload" — gateway/decode faults
      // stay on the error channel and fail the render loudly.
      User: ({ id }) =>
        getUser(id).pipe(
          Effect.map((user) => ({ ...emptyFlags, preloadedUser: user })),
          Effect.catchTag("UserNotFound", () => Effect.succeed(emptyFlags)),
        ),
      NotFound: () => Effect.succeed(emptyFlags),
    }),
  );

const statusForPage = (route: AppRoute, flags: Flags): number =>
  route._tag === "NotFound" || (route._tag === "User" && flags.preloadedUser === null) ? 404 : 200;

export const renderPage = (request: Request): Promise<Server.ServerEntryResult> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const url = Option.getOrThrowWith(
        urlFromString(request.url),
        () => new Error(`Cannot render the invalid URL "${request.url}".`),
      );
      const route = urlToAppRoute(url);
      const flags = yield* flagsForRoute(route);
      const application = yield* Server.renderToString(
        { Flags, routing: {}, init, view },
        { url: request.url, flags },
      );
      return Server.Rendered(application, {
        status: statusForPage(route, flags),
        headers: { "cache-control": "no-store" },
      });
    }).pipe(Effect.provide(AppClientInProcess)),
  );
