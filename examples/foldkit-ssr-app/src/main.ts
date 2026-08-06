import { Effect, Match as M, Schema as S } from "effect";
import { AsyncData, Command, Runtime } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { UserDetail, UserSummary, createUser, getUser, listUsers } from "./domain-client";
import { AppRoute, homeRouter, urlToAppRoute, userRouter } from "./route";

// MODEL

const UsersAsyncData = AsyncData.Schema(S.Array(UserSummary), S.String);
const UserAsyncData = AsyncData.Schema(UserDetail, S.String);

export const Model = S.Struct({
  route: AppRoute,
  users: UsersAsyncData.schema,
  user: UserAsyncData.schema,
  firstNameInput: S.String,
  lastNameInput: S.String,
});
export type Model = typeof Model.Type;

// MESSAGE

export const ClickedLink = m("ClickedLink", { request: UrlRequest });
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const CompletedNavigate = m("CompletedNavigate");
export const SucceededLoadUsers = m("SucceededLoadUsers", { users: S.Array(UserSummary) });
export const FailedLoadUsers = m("FailedLoadUsers", { error: S.String });
export const SucceededLoadUser = m("SucceededLoadUser", { user: UserDetail });
export const FailedLoadUser = m("FailedLoadUser", { error: S.String });
export const UpdatedFirstNameInput = m("UpdatedFirstNameInput", { value: S.String });
export const UpdatedLastNameInput = m("UpdatedLastNameInput", { value: S.String });
export const SubmittedCreateForm = m("SubmittedCreateForm");
export const SucceededCreateUser = m("SucceededCreateUser", { user: UserSummary });
export const FailedCreateUser = m("FailedCreateUser", { error: S.String });

export const Message = S.Union([
  ClickedLink,
  ChangedUrl,
  CompletedNavigate,
  SucceededLoadUsers,
  FailedLoadUsers,
  SucceededLoadUser,
  FailedLoadUser,
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

const LoadUsers = Command.define("LoadUsers", {
  messages: [SucceededLoadUsers, FailedLoadUsers],
  execute: listUsers.pipe(
    Effect.map((users) => SucceededLoadUsers({ users })),
    Effect.catch((error) => Effect.succeed(FailedLoadUsers({ error: describe(error) }))),
  ),
});

const LoadUser = Command.define("LoadUser", {
  args: { id: S.String },
  messages: [SucceededLoadUser, FailedLoadUser],
  execute: ({ id }) =>
    getUser(id).pipe(
      Effect.map((user) => SucceededLoadUser({ user })),
      // UserNotFound arrives as a class instance decoded off the wire — the
      // declared operation error survives the transport with its message.
      Effect.catch((error) => Effect.succeed(FailedLoadUser({ error: describe(error) }))),
    ),
});

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
const dataForRoute = (route: typeof AppRoute.Type): ReadonlyArray<Command.Command<Message>> =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () => [LoadUsers()],
      User: ({ id }) => [LoadUser({ id })],
      NotFound: () => [],
    }),
  );

const modelForRoute = (model: Model, route: typeof AppRoute.Type): Model =>
  M.value(route).pipe(
    M.tagsExhaustive({
      Home: () => evo(model, { route: () => route, users: () => UsersAsyncData.Loading() }),
      User: () => evo(model, { route: () => route, user: () => UserAsyncData.Loading() }),
      NotFound: () => evo(model, { route: () => route }),
    }),
  );

// FLAGS

// The hydration payload IS a domain projection: both fields are
// `domain.responseSchema` values, so the server encodes what it fetched with
// the domain's own wire codec and the hydrating client decodes it with the
// same cached schema object. No hand-written DTO sits between server render
// and browser state.
export const Flags = S.Struct({
  preloadedUsers: S.NullOr(S.Array(UserSummary)),
  preloadedUser: S.NullOr(UserDetail),
});
export type Flags = typeof Flags.Type;

// Fresh (non-hydrating) renders have nothing preloaded and take the normal
// Loading -> fetch path. Hydration never runs this: it replays the Flags
// embedded in the server's HTML.
export const flags: Effect.Effect<Flags> = Effect.succeed({
  preloadedUsers: null,
  preloadedUser: null,
});

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags: Flags,
  url: Url,
) => {
  const route = urlToAppRoute(url);
  const model: Model = {
    route,
    users: UsersAsyncData.Idle(),
    user: UserAsyncData.Idle(),
    firstNameInput: "",
    lastNameInput: "",
  };
  // When the server already ran this route's projection, start in Success and
  // fetch nothing — the browser adopts the server's Model exactly. Later
  // navigations fall through to the same dataForRoute the server entry uses.
  const { preloadedUsers, preloadedUser } = flags;
  if (route._tag === "Home" && preloadedUsers !== null) {
    return [evo(model, { users: () => UsersAsyncData.Success({ data: preloadedUsers }) }), []];
  }
  if (route._tag === "User" && preloadedUser !== null && preloadedUser.id === route.id) {
    return [evo(model, { user: () => UserAsyncData.Success({ data: preloadedUser }) }), []];
  }
  return [modelForRoute(model, route), dataForRoute(route)];
};

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];
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
        return [modelForRoute(model, route), dataForRoute(route)];
      },

      CompletedNavigate: () => [model, []],

      SucceededLoadUsers: ({ users }) => [
        evo(model, { users: () => UsersAsyncData.Success({ data: users }) }),
        [],
      ],
      FailedLoadUsers: ({ error }) => [
        evo(model, { users: () => UsersAsyncData.Failure({ error }) }),
        [],
      ],
      SucceededLoadUser: ({ user }) => [
        evo(model, { user: () => UserAsyncData.Success({ data: user }) }),
        [],
      ],
      FailedLoadUser: ({ error }) => [
        evo(model, { user: () => UserAsyncData.Failure({ error }) }),
        [],
      ],

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
        evo(model, { users: () => UsersAsyncData.Failure({ error }) }),
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

const asyncDataView = <A>(
  data: AsyncData.AsyncData<A, string>,
  h: HtmlBuilder<Message>,
  success: (value: A) => Html,
): Html =>
  M.value(data).pipe(
    M.tagsExhaustive({
      Idle: () => h.p([h.Class("status")], ["—"]),
      Loading: () => h.p([h.Class("status")], ["Loading…"]),
      Refreshing: ({ data: value }) => success(value),
      Stale: ({ data: value }) => success(value),
      Failure: ({ error }) => h.p([h.Class("status error")], [error]),
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
  asyncDataView(model.user, h, (user) =>
    h.div(
      [h.Class("user-card")],
      [
        h.h2([], [user.greeting]),
        h.p([], [user.profile.bio]),
        h.p([h.Class("location")], [user.profile.location]),
      ],
    ),
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
