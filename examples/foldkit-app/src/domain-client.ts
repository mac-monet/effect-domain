// The client end of the wire, behind a service tag. `Domain.client` recovers
// exact `domain.execute` typing — operation names, args, selections,
// selection-dependent result types — from the domain itself. The tag is the
// swappable seam: the entry provides the HTTP client below through foldkit's
// `resources` Layer, tests can provide a stub, and a server entry (see the
// foldkit-ssr-app sibling) can provide the in-process `Domain.client(domain)`
// for the same calls without any wire.
import { Context, Effect, Layer } from "effect";
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

export const createUser = (firstName: string, lastName: string) =>
  Effect.gen(function* () {
    const client = yield* AppClient;
    return yield* client.execute({
      name: "createUser",
      args: { firstName, lastName },
      select: summarySelect,
    });
  });
