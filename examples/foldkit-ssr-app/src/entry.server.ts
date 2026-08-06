// The application's server boundary, in the shape foldkit's SSR hosts expect:
// one Web Request in, one ServerEntryResult out.
//
// The interesting part is where Flags come from. The server holds the domain,
// so it runs the same `dataForRoute` intent as the client — but through
// `domain.execute`, in-process, no HTTP hop — using the exact selections the
// client's Commands use. The resulting projection goes into Flags, is encoded
// by `responseSchema`'s wire codec into the HTML payload, and the hydrating
// browser decodes it with the same schema object and runs the same `init`.
// Server HTML and browser state cannot disagree: both are projections of one
// selection.
import { Effect, Match as M, Option } from "effect";
import * as Server from "foldkit/experimental/server";
import { fromString as urlFromString } from "foldkit/url";

import { domain } from "../../domain.ts";
import { detailSelect, summarySelect } from "./domain-client";
import { Flags, init, view } from "./main";
import { AppRoute, urlToAppRoute } from "./route";
import { runtime } from "./server-runtime";

const emptyFlags: Flags = { preloadedUsers: null, preloadedUser: null };

const flagsForRoute = (route: AppRoute) =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () =>
        domain
          .execute("listUsers", { select: summarySelect })
          .pipe(Effect.map((users) => ({ ...emptyFlags, preloadedUsers: users }))),
      // An unknown id renders with nothing preloaded; the client's own
      // LoadUser then surfaces the UserNotFound error the normal way.
      User: ({ id }) =>
        domain.execute("getUser", { args: { id }, select: detailSelect }).pipe(
          Effect.map((user) => ({ ...emptyFlags, preloadedUser: user })),
          Effect.catch(() => Effect.succeed(emptyFlags)),
        ),
      NotFound: () => Effect.succeed(emptyFlags),
    }),
  );

export const renderPage = (request: Request): Promise<Server.ServerEntryResult> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const url = Option.getOrThrowWith(
        urlFromString(request.url),
        () => new Error(`Cannot render the invalid URL "${request.url}".`),
      );
      const flags = yield* flagsForRoute(urlToAppRoute(url));
      const application = yield* Server.renderToString(
        { Flags, routing: {}, init, view },
        { url: request.url, flags },
      );
      return Server.Rendered(application, {
        headers: { "cache-control": "no-store" },
      });
    }),
  );
