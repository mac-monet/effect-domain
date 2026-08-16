import { Effect, Match as M, Schema as S } from "effect";
import { AsyncData, Command, Runtime } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { Domain } from "../../../src/index.ts";
import { AppClient, UserQuery, UserSummary, UsersQuery, createUser } from "./domain-client";
import { AppRoute, homeRouter, urlToAppRoute, userRouter } from "./route";

// MODEL

// Both async slots come straight from the domain-generated query bundles:
// data schema, typed error schema, and the six-state codec in one value.
export const Model = S.Struct({
  route: AppRoute,
  users: UsersQuery.asyncData.schema,
  user: UserQuery.asyncData.schema,
  detailLevel: S.Literals(["compact", "expanded"]),
  firstNameInput: S.String,
  lastNameInput: S.String,
});
export type Model = typeof Model.Type;

// MESSAGE

export const ClickedLink = m("ClickedLink", { request: UrlRequest });
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const CompletedNavigate = m("CompletedNavigate");
export const ToggledDetail = m("ToggledDetail");
export const UpdatedFirstNameInput = m("UpdatedFirstNameInput", { value: S.String });
export const UpdatedLastNameInput = m("UpdatedLastNameInput", { value: S.String });
export const SubmittedCreateForm = m("SubmittedCreateForm");
export const SucceededCreateUser = m("SucceededCreateUser", { user: UserSummary });
export const FailedCreateUser = m("FailedCreateUser", { error: S.String });

export const Message = S.Union([
  ClickedLink,
  ChangedUrl,
  CompletedNavigate,
  UsersQuery.Settled,
  UserQuery.Settled,
  ToggledDetail,
  UpdatedFirstNameInput,
  UpdatedLastNameInput,
  SubmittedCreateForm,
  SucceededCreateUser,
  FailedCreateUser,
]);
export type Message = typeof Message.Type;

// COMMAND

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The create mutation stays hand-written: it navigates on success instead of
// settling into an AsyncData slot, so the query bridge doesn't apply.
const CreateUser = Command.define("CreateUser", {
  args: { firstName: S.String, lastName: S.String },
  messages: [SucceededCreateUser, FailedCreateUser],
  execute: ({ firstName, lastName }) =>
    createUser(firstName, lastName).pipe(
      Effect.map((user) => SucceededCreateUser({ user })),
      Effect.catch((error) => Effect.succeed(FailedCreateUser({ error: describe(error) }))),
    ),
});

const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: S.String },
  messages: [CompletedNavigate],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(CompletedNavigate())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: S.String },
  messages: [CompletedNavigate],
  execute: ({ href }) => load(href).pipe(Effect.as(CompletedNavigate())),
});

// Every route's data needs in one place: the mapping a server render would
// run ahead of time is the same one the client runs on navigation.
const dataForRoute = (
  route: typeof AppRoute.Type,
  level: Model["detailLevel"],
): ReadonlyArray<Command.Command<Message, never, AppClient>> =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () => [UsersQuery.Load({})],
      User: ({ id }) => [UserQuery.Load({ id, level })],
      NotFound: () => [],
    }),
  );

const modelForRoute = (model: Model, route: typeof AppRoute.Type): Model =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () => evo(model, { route: () => route, users: () => AsyncData.Loading() }),
      User: () => evo(model, { route: () => route, user: () => AsyncData.Loading() }),
      NotFound: () => evo(model, { route: () => route }),
    }),
  );

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, void, AppClient> = (url: Url) => {
  const route = urlToAppRoute(url);
  const model: Model = {
    route,
    users: AsyncData.Idle(),
    user: AsyncData.Idle(),
    detailLevel: "compact",
    firstNameInput: "",
    lastNameInput: "",
  };
  return [modelForRoute(model, route), dataForRoute(route, model.detailLevel)];
};

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message, never, AppClient>>];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      ClickedLink: ({ request }) =>
        M.value(request).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            Internal: ({ url }) => [model, [NavigateInternal({ url: urlToString(url) })]],
            External: ({ href }) => [model, [LoadExternal({ href })]],
          }),
        ),

      ChangedUrl: ({ url }) => {
        const route = urlToAppRoute(url);
        return [modelForRoute(model, route), dataForRoute(route, model.detailLevel)];
      },

      CompletedNavigate: () => [model, []],

      // One arm per query: settle folds the Result into the previous state,
      // keeping the last good data on a failed refresh (Stale) for free.
      SettledUsers: ({ result }) => [evo(model, { users: AsyncData.settle(result) }), []],
      SettledUser: ({ result }) => [evo(model, { user: AsyncData.settle(result) }), []],

      // The toggle is a refetch: a different selection goes over the wire.
      ToggledDetail: () => {
        const detailLevel = model.detailLevel === "compact" ? "expanded" : "compact";
        const next = evo(model, {
          detailLevel: () => detailLevel,
          user: () => AsyncData.Loading(),
        });
        return M.value(model.route).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            User: ({ id }) => [next, [UserQuery.Load({ id, level: detailLevel })]],
            Home: () => [model, []],
            NotFound: () => [model, []],
          }),
        );
      },

      UpdatedFirstNameInput: ({ value }) => [evo(model, { firstNameInput: () => value }), []],
      UpdatedLastNameInput: ({ value }) => [evo(model, { lastNameInput: () => value }), []],

      SubmittedCreateForm: () => {
        if (model.firstNameInput === "" || model.lastNameInput === "") {
          return [model, []];
        }
        return [
          evo(model, { firstNameInput: () => "", lastNameInput: () => "" }),
          [CreateUser({ firstName: model.firstNameInput, lastName: model.lastNameInput })],
        ];
      },

      // Surface a create failure in the list's error slot.
      FailedCreateUser: ({ error }) => [
        evo(model, {
          users: () =>
            UsersQuery.asyncData.Failure({ error: new Domain.TransportError({ message: error }) }),
        }),
        [],
      ],

      // Jump straight to the new user's page; its route load refetches.
      SucceededCreateUser: ({ user }) => [
        model,
        [NavigateInternal({ url: userRouter({ id: user.id }) })],
      ],
    }),
  );

// VIEW

// The error slot is typed now — declared domain errors and TransportError
// both carry `message`, so the generic view renders that.
const asyncDataView = <A, E extends { readonly message: string }>(
  data: AsyncData.AsyncData<A, E>,
  h: HtmlBuilder<Message>,
  success: (value: A) => Html,
): Html =>
  M.value(data).pipe(
    M.tagsExhaustive({
      Idle: () => h.p([h.Class("status")], ["—"]),
      Loading: () => h.p([h.Class("status")], ["Loading…"]),
      Refreshing: ({ data: value }) => success(value),
      Stale: ({ data: value }) => success(value),
      Failure: ({ error }) => h.p([h.Class("status error")], [error.message]),
      Success: ({ data: value }) => success(value),
    }),
  );

const homeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.form(
        [h.Class("create-form"), h.OnSubmit(SubmittedCreateForm())],
        [
          h.input([
            h.Value(model.firstNameInput),
            h.Placeholder("First name"),
            h.OnInput((value) => UpdatedFirstNameInput({ value })),
          ]),
          h.input([
            h.Value(model.lastNameInput),
            h.Placeholder("Last name"),
            h.OnInput((value) => UpdatedLastNameInput({ value })),
          ]),
          h.button([h.Type("submit")], ["Create user"]),
        ],
      ),
      asyncDataView(model.users, h, (users) =>
        h.ul(
          [h.Class("user-list")],
          users.map((user) =>
            h.li([], [h.a([h.Href(userRouter({ id: user.id }))], [user.fullName])]),
          ),
        ),
      ),
    ],
  );

const userView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.button(
        [h.OnClick(ToggledDetail())],
        [model.detailLevel === "compact" ? "Show details" : "Hide details"],
      ),
      asyncDataView(model.user, h, (user) =>
        h.div(
          [h.Class("user-card")],
          // The union is closed, so a presence check narrows it: the compact
          // branch cannot reach for fields its selection never asked for.
          "greeting" in user
            ? [
                h.h2([], [user.greeting]),
                h.p([], [user.profile.bio]),
                h.p([h.Class("location")], [user.profile.location]),
              ]
            : [h.h2([], [user.fullName])],
        ),
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
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
