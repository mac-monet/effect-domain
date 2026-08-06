// The whole application: a Model schema, an init, and a view. There is no
// update, no Messages, no Commands, and no client runtime — every interaction
// is a plain HTTP request and the server renders the next page. What survives
// from the SPA version is exactly the projection layer: the selections in
// projection.ts and the view below.
import { Match as M, Schema as S } from "effect";
import type { Runtime } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import type { Url } from "foldkit/url";

import { UserDetail, UserSummary } from "./projection";
import { AppRoute, homeRouter, urlToAppRoute, userRouter } from "./route";

// FLAGS / MODEL

// Flags carry the route's data, fetched by the server entry through
// `domain.execute` with the same selections `responseSchema` derived the
// schemas below from. The Model is the Flags plus the parsed route: with no
// browser fold to feed, there is nothing else to model — no AsyncData, no
// loading states, no form inputs.
export const Flags = S.Struct({
  users: S.NullOr(S.Array(UserSummary)),
  user: S.NullOr(UserDetail),
});
export type Flags = typeof Flags.Type;

export const Model = S.Struct({
  ...Flags.fields,
  route: AppRoute,
});
export type Model = typeof Model.Type;

// INIT

export const init: Runtime.RoutingApplicationInit<Model, unknown, Flags> = (
  flags: Flags,
  url: Url,
) => [{ ...flags, route: urlToAppRoute(url) }, []];

// VIEW

const homeView = (model: Model, h: HtmlBuilder<unknown>): Html =>
  h.div(
    [],
    [
      // A native form: the browser POSTs it, the server entry executes
      // `createUser` and redirects to the new user's page.
      h.form(
        [h.Class("create-form"), h.Method("post"), h.Action("/users")],
        [
          h.input([h.Name("firstName"), h.Placeholder("First name")]),
          h.input([h.Name("lastName"), h.Placeholder("Last name")]),
          h.button([h.Type("submit")], ["Create user"]),
        ],
      ),
      h.ul(
        [h.Class("user-list")],
        (model.users ?? []).map((user) =>
          h.li([], [h.a([h.Href(userRouter({ id: user.id }))], [user.fullName])]),
        ),
      ),
    ],
  );

const userView = (model: Model, h: HtmlBuilder<unknown>): Html =>
  model.user === null
    ? h.p([h.Class("status error")], ["No such user"])
    : h.div(
        [h.Class("user-card")],
        [
          h.h2([], [model.user.greeting]),
          h.p([], [model.user.profile.bio]),
          h.p([h.Class("location")], [model.user.profile.location]),
        ],
      );

export const view = (model: Model, h: HtmlBuilder<unknown>): Document => ({
  title: "Users",
  body: h.div(
    [h.Class("app")],
    [
      h.header([], [h.a([h.Href(homeRouter())], ["Users"])]),
      h.main(
        [],
        [
          M.value(model.route).pipe(
            M.tagsExhaustive({
              Home: () => homeView(model, h),
              User: () => userView(model, h),
              NotFound: ({ path }) => h.p([h.Class("status")], [`No page at ${path}`]),
            }),
          ),
        ],
      ),
    ],
  ),
});
