// The client end of the wire. `Domain.wireClient` recovers exact
// `domain.execute` typing — operation names, args, selections,
// selection-dependent result types — from the domain itself; this file only
// supplies the transport: POST the dispatch envelope to /rpc. Every response
// is decoded through the domain's own response codec inside `wireClient`, so
// successes arrive as plain typed selection trees and failures as typed
// errors (UserNotFound) — no second decode needed here.
import { Effect, Schema, Stream } from "effect";
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

export const client = Domain.wireClient(domain, transport);

// These schemas exist for the Foldkit side (Message payloads, AsyncData) —
// the wire results below already conform to them without decoding.
export const UserSummary = Schema.Struct({
  id: Schema.String,
  fullName: Schema.String,
});
export type UserSummary = typeof UserSummary.Type;

export const UserDetail = Schema.Struct({
  id: Schema.String,
  fullName: Schema.String,
  greeting: Schema.String,
  profile: Schema.Struct({
    bio: Schema.String,
    location: Schema.String,
  }),
});
export type UserDetail = typeof UserDetail.Type;

// One UI-facing effect per screen need: each picks its own selection, so a
// screen fetches exactly the fields it renders.
export const listUsers = client.execute("listUsers", {
  select: { id: true, fullName: true },
});

export const getUser = (id: string) =>
  client.execute("getUser", {
    args: { id },
    select: {
      id: true,
      fullName: true,
      greeting: { args: { salutation: "Hello" } },
      profile: { select: { bio: true, location: true } },
    },
  });

export const createUser = (firstName: string, lastName: string) =>
  client.execute("createUser", {
    args: { firstName, lastName },
    select: { id: true, fullName: true },
  });
