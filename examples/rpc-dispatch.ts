// Dynamic typed RPC: the whole domain behind two static procedures
// (DomainExecute, DomainSubscribe), with a domain-aware client whose
// operation names, args, selections, and selection-dependent result types
// match `domain.execute` / `domain.subscribe` exactly.
//
// Fixed, per-operation procedures should prefer `domain.bind(...)` with
// native RpcGroup declarations (see rpc-fixed.ts / rpc-stream.ts).
import { Effect, Result, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import {
  DispatchRequestSchema,
  type DispatchRequest,
  Domain,
  type DomainInstance,
  GatewayError,
  OperationError,
  type PreparedDispatch,
  type RootSelectionFor,
  type Selection,
} from "../src/index.ts";
import type * as DomainTypes from "../src/domain/type-level.ts";
import type { AnyOperationDef } from "../src/define.ts";
import { domain, UserRepoLive } from "./domain.ts";

// ---------------------------------------------------------------------------
// Wire: one execute procedure, one subscribe procedure, both static. The
// payload is the untyped DispatchRequest envelope; typing is recovered on the
// client from the domain itself.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Enforcement: constructing the adapter for a domain where some fallible
// operation declared no `error` schema is a compile error naming the ops.
// ---------------------------------------------------------------------------

type RequireErrorSchemas<Ops extends Record<string, AnyOperationDef>> = [
  Domain.MissingErrorSchemas<Ops>,
] extends [never]
  ? unknown
  : {
      readonly "operations missing a declared error schema": Domain.MissingErrorSchemas<Ops>;
    };

type QueryName<Ops extends Record<string, AnyOperationDef>> = DomainTypes.OperationNamesByStream<
  Ops,
  false
>;
type SubscriptionName<Ops extends Record<string, AnyOperationDef>> =
  DomainTypes.OperationNamesByStream<Ops, true>;

type ClientErrors<Op> =
  | DomainTypes.DeclaredErrorType<Op>
  | GatewayError
  | RpcClientError.RpcClientError
  | Schema.SchemaError;

type InvokeConfig<Op, S> = Omit<
  DomainTypes.DomainExecuteConfig<DomainTypes.ExtractType<Op>, DomainTypes.ExtractArgs<Op>, S>,
  "reads" | "concurrency"
>;

export interface DomainRpcClient<Ops extends Record<string, AnyOperationDef>> {
  execute<
    K extends QueryName<Ops>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>>,
  >(
    name: K,
    config: InvokeConfig<Ops[K], S>,
  ): Effect.Effect<
    DomainTypes.DomainRootResultOf<DomainTypes.ExtractType<Ops[K]>, S>,
    ClientErrors<Ops[K]>
  >;
  subscribe<
    K extends SubscriptionName<Ops>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>>,
  >(
    name: K,
    config: InvokeConfig<Ops[K], S>,
  ): Stream.Stream<
    DomainTypes.DomainRootResultOf<DomainTypes.ExtractType<Ops[K]>, S>,
    ClientErrors<Ops[K]>
  >;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const makeDomainRpc = <Ops extends Record<string, AnyOperationDef>, Provided, PE, PR>(
  dom: DomainInstance<Ops, Provided, PE, PR> & RequireErrorSchemas<Ops>,
) => {
  const codecFor = (name: string, select: Selection | undefined) =>
    dom.dispatchResultSchemaDynamic(name, select);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provided sits in an Exclude<>; only `any` unifies every provided domain.
  const serverLayer = (liveDomain: DomainInstance<Ops, any, never, never>) => {
    // A fully provided domain's prepared dispatch needs no services; the
    // generic Provided/AllR machinery can't reduce that, so pin it here.
    const prepare = (config: DispatchRequest) =>
      liveDomain.prepareDispatch(config) as Effect.Effect<
        PreparedDispatch<never, unknown>,
        GatewayError
      >;
    const encodeWith = (request: DispatchRequest, select: Selection | undefined) =>
      Schema.encodeEffect(codecFor(request.name, select));
    return DomainRpcs.toLayer({
      DomainExecute: (request: DispatchRequest) =>
        prepare(request).pipe(
          Effect.matchEffect({
            onFailure: (gatewayError) => encodeWith(request, undefined)(Result.fail(gatewayError)),
            onSuccess: (prepared) =>
              prepared.execute().pipe(Effect.flatMap(encodeWith(request, prepared.select))),
          }),
          Effect.orDie,
        ),
      DomainSubscribe: (request: DispatchRequest) =>
        liveDomain
          .dispatchSubscription(request)
          .pipe(
            Stream.mapEffect((item) =>
              encodeWith(
                request,
                request.select as Selection | undefined,
              )(item as Result.Result<unknown, GatewayError | OperationError<unknown>>).pipe(
                Effect.orDie,
              ),
            ),
          ),
    });
  };

  const unwrap = <A>(result: Result.Result<A, GatewayError | OperationError<unknown>>) =>
    Result.isFailure(result)
      ? Effect.fail(
          result.failure instanceof OperationError ? result.failure.cause : result.failure,
        )
      : Effect.succeed(result.success);

  // Structural raw-client type: works for RpcClient.make and RpcTest.makeClient.
  const clientFrom = (client: {
    DomainExecute: (payload: DispatchRequest) => Effect.Effect<unknown, unknown>;
    DomainSubscribe: (payload: DispatchRequest) => Stream.Stream<unknown, unknown>;
  }) => {
    const decode = (name: string, select: unknown) =>
      Schema.decodeUnknownEffect(codecFor(name, select as Selection | undefined));
    return {
      execute: (name: string, config: { args?: unknown; select?: unknown }) =>
        client
          .DomainExecute({ name, args: config.args, select: config.select })
          .pipe(Effect.flatMap(decode(name, config.select)), Effect.flatMap(unwrap)),
      subscribe: (name: string, config: { args?: unknown; select?: unknown }) =>
        client
          .DomainSubscribe({ name, args: config.args, select: config.select })
          .pipe(
            Stream.mapEffect((item) =>
              decode(name, config.select)(item).pipe(Effect.flatMap(unwrap)),
            ),
          ),
      // The generic surface above is untyped by construction (runtime name
      // strings); the interface restores exact `domain.execute` typing.
    } as unknown as DomainRpcClient<Ops>;
  };

  const makeClient: Effect.Effect<
    DomainRpcClient<Ops>,
    never,
    RpcClient.Protocol | Scope.Scope
  > = Effect.map(RpcClient.make(DomainRpcs), clientFrom);

  return { group: DomainRpcs, serverLayer, clientFrom, makeClient };
};

// ---------------------------------------------------------------------------
// Wired to the example domain
// ---------------------------------------------------------------------------

export const rpc = makeDomainRpc(domain);
export const RpcLive = rpc.serverLayer(domain.provide(UserRepoLive));
