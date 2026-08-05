// The client end of the wire. `Domain.wireClient` recovers exact
// `domain.execute` typing — operation names, args, selections,
// selection-dependent result types — from the domain itself; this file only
// supplies the transport: POST the dispatch envelope to /rpc. Successes are
// plain selected data trees; failures arrive typed (UserNotFound).
import { Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { Http } from "foldkit";
import { Domain, type DispatchRequest } from "../../../src/index.ts";
import { domain, UserNotFound } from "../../domain.ts";

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

const decoded = <A, I, E>(
  effect: Effect.Effect<unknown, E>,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, E | Schema.SchemaError> =>
  effect.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

// One UI-facing effect per screen need: each picks its own selection, so a
// screen fetches exactly the fields it renders.
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

export const listUsers = decoded(
  client.execute("listUsers", { select: { id: true, fullName: true } }),
  Schema.Array(UserSummary),
);

export const getUser = (id: string) =>
  decoded(
    client.execute("getUser", {
      args: { id },
      select: {
        id: true,
        fullName: true,
        greeting: { args: { salutation: "Hello" } },
        profile: { select: { bio: true, location: true } },
      },
    }),
    UserDetail,
  );

export const createUser = (firstName: string, lastName: string) =>
  decoded(
    client.execute("createUser", {
      args: { firstName, lastName },
      select: { id: true, fullName: true },
    }),
    UserSummary,
  );

export { UserNotFound };
