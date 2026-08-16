// The client end of the wire, behind a service tag. `Domain.client` recovers
// exact `domain.execute` typing — operation names, args, selections,
// selection-dependent result types — from the domain itself. The tag is the
// swappable seam: the entry provides the HTTP client below through foldkit's
// `resources` Layer, tests can provide a stub, and a server entry (see the
// foldkit-ssr-app sibling) can provide the in-process `Domain.client(domain)`
// for the same calls without any wire.
import { Context, Effect, Layer, Schema as S } from "effect";
import { AsyncData, Command } from "foldkit";
import { m } from "foldkit/message";
import { Domain } from "../../../src/index.ts";
import { domain } from "../../domain.ts";

// The canonical wire: POST each envelope to /rpc, decode with the
// domain's own codec. Transport failures surface as Domain.TransportError.
const httpClient = Domain.client(domain, Domain.transportHttp("/rpc"));
export type AppClientShape = typeof httpClient;

// The seam: Commands depend on this tag, entries decide what fills it.
export class AppClient extends Context.Service<AppClient, AppClientShape>()("AppClient") {}

export const AppClientHttp = Layer.succeed(AppClient)(httpClient);

// One selection per screen need, written once: the same value drives what
// `execute` fetches and, through `domain.responseSchema`, the runtime Schema
// the Foldkit side needs (Message payloads, AsyncData, Flags). Schema and
// fetch cannot drift — both are projections of the selection.
export const summarySelect = { id: true, fullName: true } as const;

// Two selections for the same operation: the detail page picks one at runtime,
// so what goes over the wire is data the app chooses, not a shape baked into
// the call site. Each has its own derived Schema, so a runtime choice of
// selection still lands in a statically typed Model.
export const compactDetailSelect = { id: true, fullName: true } as const;
export const expandedDetailSelect = {
  id: true,
  fullName: true,
  greeting: { args: { salutation: "Hello" } },
  profile: { select: { bio: true, location: true } },
} as const;

export const UserSummary = domain.responseSchema("createUser", summarySelect);
export type UserSummary = typeof UserSummary.Type;

export const UserCompact = domain.responseSchema("getUser", compactDetailSelect);
export type UserCompact = typeof UserCompact.Type;

export const UserExpanded = domain.responseSchema("getUser", expandedDetailSelect);
export type UserExpanded = typeof UserExpanded.Type;

export type DetailLevel = "compact" | "expanded";

// One UI-facing effect per screen need: each picks its own selection, so a
// screen fetches exactly the fields it renders. All of them read the client
// from the AppClient tag — which client that is depends on the entry.
export const listUsers = Effect.gen(function* () {
  const client = yield* AppClient;
  return yield* client.execute({ name: "listUsers", select: summarySelect });
});

// Two branches, one literal selection each: the result type is the union of
// the two selection results, so callers keep exact field-level typing.
export const getUser = (id: string, level: DetailLevel) =>
  Effect.gen(function* () {
    const client = yield* AppClient;
    return level === "compact"
      ? yield* client.execute({ name: "getUser", args: { id }, select: compactDetailSelect })
      : yield* client.execute({ name: "getUser", args: { id }, select: expandedDetailSelect });
  });

// THE BRIDGE — the domain generates the async state Foldkit needs.
//
// For a query, the domain already produces both halves of Foldkit's
// AsyncData: `responseSchema` is the data schema, `errorSchema` the declared
// error schema. `settledQuery` composes them into the full bundle: the
// AsyncData codec for the Model slot, one `Settled` Message whose payload is
// the `Result` the fetch produces, and the Load Command that runs the fetch
// through `Effect.result`. One `AsyncData.settle` arm in update folds it in.
//
// Error policy: declared operation errors stay typed (they decode back to
// class instances off the wire); every infrastructure failure — transport,
// gateway, response decoding — collapses into `Domain.TransportError`. The
// UI matches on domain errors; everything else is "request failed". Both
// carry `message`, so a generic view can always render one.
export const settledQuery = <
  const Tag extends string,
  Data extends S.Top,
  DeclaredError extends S.Top,
  ArgFields extends S.Struct.Fields = {},
>(config: {
  tag: Tag;
  data: Data;
  error: DeclaredError;
  args?: ArgFields;
  fetch: (args: S.Struct.Type<ArgFields>) => Effect.Effect<Data["Type"], unknown, AppClient>;
}) => {
  type A = Data["Type"];
  type E = DeclaredError["Type"] | Domain.TransportError;
  const error = S.Union([config.error, Domain.TransportError]) as unknown as S.Codec<E, unknown>;
  const data = config.data as unknown as S.Codec<A, unknown>;
  const isDeclared = S.is(config.error);
  const normalize = (e: unknown): E => {
    const message = e instanceof Error ? e.message : String(e);
    return e instanceof Domain.TransportError || isDeclared(e)
      ? (e as E)
      : new Domain.TransportError({ message });
  };

  const asyncData = AsyncData.Schema(data, error);
  const Settled = m(`Settled${config.tag}`, { result: S.Result(data, error) });
  const run = (args: S.Struct.Type<ArgFields>) =>
    config.fetch(args).pipe(
      Effect.mapError(normalize),
      Effect.result,
      Effect.map((result) => Settled({ result })),
    );
  const Load = config.args
    ? Command.define(`Load${config.tag}`, {
        args: config.args,
        messages: [Settled],
        execute: run,
      })
    : Command.define(`Load${config.tag}`, {
        messages: [Settled],
        execute: run({} as S.Struct.Type<ArgFields>),
      });
  return {
    asyncData,
    Settled,
    Load: Load as Command.CommandDefinitionWithArgs<
      `Load${Tag}`,
      ArgFields,
      Effect.Effect<typeof Settled.Type, never, AppClient>
    >,
  };
};

export const createUser = (firstName: string, lastName: string) =>
  Effect.gen(function* () {
    const client = yield* AppClient;
    return yield* client.execute({
      name: "createUser",
      args: { firstName, lastName },
      select: summarySelect,
    });
  });

// The detail slot holds whichever projection the last fetch asked for. The
// union is closed, so the view still matches on statically known fields.
// Expanded goes first: union decoding takes the first member that matches,
// and the compact member would otherwise strip the extra fields.
export const UserDetail = S.Union([UserExpanded, UserCompact]);
export const DetailLevel = S.Literals(["compact", "expanded"]);

// The app's two queries, fully domain-generated: data schemas from
// `responseSchema`, error schemas from `errorSchema`, and the AsyncData /
// Message / Command bundle from the bridge.
export const UsersQuery = settledQuery({
  tag: "Users",
  data: S.Array(UserSummary),
  error: domain.errorSchema("listUsers"),
  fetch: () => listUsers,
});

export const UserQuery = settledQuery({
  tag: "User",
  data: UserDetail,
  error: domain.errorSchema("getUser"),
  args: { id: S.String, level: DetailLevel },
  fetch: ({ id, level }) => getUser(id, level),
});
