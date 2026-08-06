// Dynamic typed RPC: the whole domain behind two static procedures
// (DomainExecute, DomainSubscribe). The server side is
// `domain.handleDispatch` / `handleSubscription`; the client side is
// `Domain.client`, which recovers exact `domain.execute` /
// `domain.subscribe` typing from the domain itself. This file only supplies
// the transport: how envelopes move over Effect RPC.
//
// Fixed, per-operation procedures should prefer `domain.bind(...)` with
// native RpcGroup declarations (see rpc-fixed.ts / rpc-stream.ts).
import { Effect, Schema } from "effect";
import type { Stream } from "effect";
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import {
  type DispatchRequest,
  DispatchRequestSchema,
  Domain,
  type DomainInstance,
} from "../src/index.ts";
import type { AnyOperationDef } from "../src/define.ts";
import { domain, UserRepoLive } from "./domain.ts";

export const DomainRpcs = RpcGroup.make(
  Rpc.make("DomainExecute", {
    payload: DispatchRequestSchema,
    success: Schema.Unknown,
  }),
  Rpc.make("DomainSubscribe", {
    payload: DispatchRequestSchema,
    success: Schema.Unknown,
    stream: true,
  }),
);

// Structural raw-client shape: satisfied by RpcClient.make and RpcTest.makeClient.
interface RawRpcClient {
  DomainExecute: (
    payload: DispatchRequest,
  ) => Effect.Effect<unknown, RpcClientError.RpcClientError>;
  DomainSubscribe: (
    payload: DispatchRequest,
  ) => Stream.Stream<unknown, RpcClientError.RpcClientError>;
}

export const makeDomainRpc = <Ops extends Record<string, AnyOperationDef>, Provided, PE, PR>(
  dom: DomainInstance<Ops, Provided, PE, PR> & Domain.RequireErrorSchemas<Ops>,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provided sits in an Exclude<>; only `any` unifies every provided domain.
  const serverLayer = (
    liveDomain: DomainInstance<Ops, any, never, never> & Domain.RequireErrorSchemas<Ops>,
  ) =>
    // A fully provided domain needs no services, so pin R to never.
    DomainRpcs.toLayer({
      DomainExecute: (request: DispatchRequest) =>
        liveDomain.handleDispatch(request) as Effect.Effect<unknown>,
      DomainSubscribe: (request: DispatchRequest) =>
        liveDomain.handleSubscription(request) as Stream.Stream<unknown>,
    });

  const clientFrom = (client: RawRpcClient) =>
    Domain.client(dom, {
      execute: (request) => client.DomainExecute(request),
      subscribe: (request) => client.DomainSubscribe(request),
    });

  const makeClient = Effect.map(RpcClient.make(DomainRpcs), clientFrom);

  return { group: DomainRpcs, serverLayer, clientFrom, makeClient };
};

export const rpc = makeDomainRpc(domain);
export const RpcLive = rpc.serverLayer(domain.provide(UserRepoLive));
