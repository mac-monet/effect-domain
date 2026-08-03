import { Effect, Result, Schema, Stream } from "effect";
import type { AnyOperationDef } from "../define.ts";
import { type DispatchRequest, GatewayError, OperationError } from "../gateway.ts";
import type { RootSelectionFor, Selection } from "../selection/syntax.ts";
import type { DomainInstance } from "./interface.ts";
import type * as DomainTypes from "./type-level.ts";

/**
 * Constraint for adapter entry points that serialize failures: satisfied
 * only when every fallible operation declared an `error` schema. Otherwise
 * the offending operation names surface in the compile error. Apply it at
 * the adapter boundary (`dom: DomainInstance<Ops, ...> & RequireErrorSchemas<Ops>`)
 * — never at `Domain.make`, where domains used purely in-process shouldn't
 * pay for schemas they don't need.
 *
 * @since 0.3.0
 * @category models
 */
export type RequireErrorSchemas<Ops extends Record<string, AnyOperationDef>> = [
  DomainTypes.MissingErrorSchemas<Ops>,
] extends [never]
  ? unknown
  : {
      readonly "operations missing a declared error schema": DomainTypes.MissingErrorSchemas<Ops>;
    };

/**
 * What {@link wireClient} needs from a transport: send one dispatch envelope,
 * return the raw (JSON-parsed but not schema-decoded) response the server
 * built with `handleDispatch` / `handleSubscription`. `TE` is the transport's
 * own failure type (RpcClientError, a fetch error, ...) and flows into the
 * typed client's error channel.
 *
 * @since 0.3.0
 * @category models
 */
export interface WireTransport<TE> {
  readonly execute: (request: DispatchRequest) => Effect.Effect<unknown, TE>;
  readonly subscribe: (request: DispatchRequest) => Stream.Stream<unknown, TE>;
}

/**
 * Everything a wire call can fail with: the operation's declared error
 * (unwrapped from `OperationError`), a boundary `GatewayError`, a decode
 * failure, or the transport's own failure type.
 */
type ClientErrors<Op, TE> =
  | DomainTypes.DeclaredErrorType<Op>
  | GatewayError
  | Schema.SchemaError
  | TE;

type InvokeConfig<Op, S> = Omit<
  DomainTypes.DomainExecuteConfig<DomainTypes.ExtractType<Op>, DomainTypes.ExtractArgs<Op>, S>,
  "reads" | "concurrency"
>;

/**
 * A remote client with `domain.execute` / `domain.subscribe` parity:
 * operation names, args, selections, and selection-dependent result types
 * are all inferred from `Ops`, while every call round-trips a wire.
 *
 * @since 0.3.0
 * @category models
 */
export interface WireClient<Ops extends Record<string, AnyOperationDef>, TE = never> {
  execute<
    K extends DomainTypes.OperationNamesByStream<Ops, false>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>>,
  >(
    name: K,
    config: InvokeConfig<Ops[K], S>,
  ): Effect.Effect<
    DomainTypes.DomainRootResultOf<DomainTypes.ExtractType<Ops[K]>, S>,
    ClientErrors<Ops[K], TE>
  >;
  subscribe<
    K extends DomainTypes.OperationNamesByStream<Ops, true>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>>,
  >(
    name: K,
    config: InvokeConfig<Ops[K], S>,
  ): Stream.Stream<
    DomainTypes.DomainRootResultOf<DomainTypes.ExtractType<Ops[K]>, S>,
    ClientErrors<Ops[K], TE>
  >;
}

/**
 * Builds the typed client end of the wire from a domain and a transport.
 *
 * The domain supplies the decoder (`dispatchResultSchemaDynamic`) and the
 * typing; the transport supplies only "how to send". Responses decode back
 * to live `Result` / `Option` / error-class prototypes, and failures unwrap
 * out of the envelope into the error channel: `OperationError` causes become
 * the operation's declared error type, gateway errors stay as themselves.
 *
 * This is the client mirror of `handleDispatch` / `handleSubscription` —
 * glue them directly (`execute: (req) => dom.handleDispatch(req)`) for an
 * in-process round-trip, or put RPC, HTTP, or a worker in between.
 *
 * Requires every fallible operation to declare an `error` schema
 * ({@link RequireErrorSchemas}); without one, failures cannot round-trip
 * and construction is a compile error naming the operations.
 *
 * @since 0.3.0
 * @category constructors
 */
export const wireClient = <
  Ops extends Record<string, AnyOperationDef>,
  Provided,
  ProvidedE,
  ProvidedR,
  TE,
>(
  dom: DomainInstance<Ops, Provided, ProvidedE, ProvidedR> & RequireErrorSchemas<Ops>,
  transport: WireTransport<TE>,
): WireClient<Ops, TE> => {
  const decode = (name: string, select: unknown) =>
    Schema.decodeUnknownEffect(
      dom.dispatchResultSchemaDynamic(name, select as Selection | undefined),
    );

  const unwrap = <A>(result: Result.Result<A, GatewayError | OperationError<unknown>>) =>
    Result.isFailure(result)
      ? Effect.fail(
          result.failure instanceof OperationError ? result.failure.cause : result.failure,
        )
      : Effect.succeed(result.success);

  // The generic surface below is untyped by construction (runtime name
  // strings); the WireClient interface restores exact `domain.execute` typing.
  return {
    execute: (name: string, config: { args?: unknown; select?: unknown }) =>
      transport
        .execute({ name, args: config.args, select: config.select })
        .pipe(Effect.flatMap(decode(name, config.select)), Effect.flatMap(unwrap)),
    subscribe: (name: string, config: { args?: unknown; select?: unknown }) =>
      transport
        .subscribe({ name, args: config.args, select: config.select })
        .pipe(
          Stream.mapEffect((item) =>
            decode(name, config.select)(item).pipe(Effect.flatMap(unwrap)),
          ),
        ),
  } as unknown as WireClient<Ops, TE>;
};
