// The client end of the wire. `Domain.client` recovers exact
// `domain.execute` typing — operation names, args, selections,
// selection-dependent result types — from the domain itself; this file only
// supplies the transport: POST the dispatch envelope to /rpc. Every response
// is decoded through the domain's own response codec inside `client`, so
// successes arrive as plain typed selection trees and failures as typed
// errors (UserNotFound) — no second decode needed here.
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { Http } from "foldkit";
import { Domain, type DispatchRequest } from "../../../src/index.ts";
import { domain } from "../../domain.ts";

const transport = {
  execute: (request: DispatchRequest) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const httpRequest = yield* HttpClientRequest.post("/rpc").pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(request),
      );
      const response = yield* client.execute(httpRequest);
      return yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
    }).pipe(Effect.provide(Http.layer)),
  subscribe: (_request: DispatchRequest) =>
    Stream.die(new Error("this example has no subscriptions")),
};

export const client = Domain.client(domain, transport);

// One selection per screen need, written once: the same value drives what
// `execute` fetches and, through `domain.responseSchema`, the runtime Schema
// the Foldkit side needs (Message payloads, AsyncData). Schema and fetch
// cannot drift — both are projections of the selection.
const summarySelect = { id: true, fullName: true } as const;
const detailSelect = {
  id: true,
  fullName: true,
  greeting: { args: { salutation: "Hello" } },
  profile: { select: { bio: true, location: true } },
} as const;

export const UserSummary = domain.responseSchema("createUser", summarySelect);
export type UserSummary = typeof UserSummary.Type;

export const UserDetail = domain.responseSchema("getUser", detailSelect);
export type UserDetail = typeof UserDetail.Type;

// One UI-facing effect per screen need: each picks its own selection, so a
// screen fetches exactly the fields it renders.
export const listUsers = client.execute("listUsers", { select: summarySelect });

export const getUser = (id: string) =>
  client.execute("getUser", { args: { id }, select: detailSelect });

export const createUser = (firstName: string, lastName: string) =>
  client.execute("createUser", { args: { firstName, lastName }, select: summarySelect });
