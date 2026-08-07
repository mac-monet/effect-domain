import { Effect, Result, Schema, Stream } from "effect";
import type { AnyOperationDef } from "../define.ts";
import { type DispatchRequest, GatewayError, OperationError } from "../gateway.ts";
import type { Selection } from "../selection/syntax.ts";
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
 * @since 0.1.0
 * @category models
 */
export type RequireErrorSchemas<Ops extends Record<string, AnyOperationDef>> =
  DomainTypes.RequireErrorSchemas<Ops>;

/**
 * What {@link client} needs from a transport: send one dispatch envelope,
 * return the raw (JSON-parsed but not schema-decoded) response the server
 * built with `handleDispatch` / `handleSubscription`. `TE` is the transport's
 * own failure type (RpcClientError, a fetch error, ...) and flows into the
 * typed client's error channel.
 *
 * @since 0.1.0
 * @category models
 */
export interface WireTransport<TE> {
  readonly execute: (request: DispatchRequest) => Effect.Effect<unknown, TE>;
  readonly subscribe: (request: DispatchRequest) => Stream.Stream<unknown, TE>;
}

/**
/**
 * A remote client with `domain.execute` / `domain.subscribe` parity:
 * operation names, args, selections, and selection-dependent result types
 * are all inferred from `Ops`, while every call round-trips a wire.
 *
 * @since 0.1.0
 * @category models
 */
export interface WireClient<Ops extends Record<string, AnyOperationDef>, TE = never, R = never> {
  /**
   * Array form, mirroring `domain.execute([...])`: each entry dispatches
   * through the transport concurrently and decodes with its own
   * `(name, select)` codec; the result is a tuple typed per entry.
   * Fail-fast: the first failing entry interrupts its siblings. Always
   * unbounded — dispatch concurrency across the wire is transport/server
   * policy, so there is no `concurrency` option here.
   * Must stay declared before the name-based overload.
   */
  execute<const T extends ReadonlyArray<DomainTypes.ExecuteEntry<Ops>>>(
    entries: T,
  ): Effect.Effect<
    { -readonly [I in keyof T]: DomainTypes.ExecuteEntryResult<Ops, T[I]> },
    DomainTypes.ExecuteEntryWireE<Ops, T[number]> | GatewayError | Schema.SchemaError | TE,
    R
  >;
  /**
   * Canonical single form, mirroring `domain.execute({ name, args, select })`:
   * one dispatch-shaped envelope through the transport.
   */
  execute<const T extends DomainTypes.ExecuteEntry<Ops>>(
    entry: T,
  ): Effect.Effect<
    DomainTypes.ExecuteEntryResult<Ops, T>,
    DomainTypes.ExecuteEntryWireE<Ops, T> | GatewayError | Schema.SchemaError | TE,
    R
  >;
  /**
   * Canonical subscription form: one dispatch-shaped envelope.
   */
  subscribe<const T extends DomainTypes.SubscribeEntry<Ops>>(
    entry: T,
  ): Stream.Stream<
    DomainTypes.ExecuteEntryResult<Ops, T>,
    DomainTypes.ExecuteEntryWireE<Ops, T> | GatewayError | Schema.SchemaError | TE,
    R
  >;
}

/**
 * The client type for a given domain instance — what an app-level
 * `Context.Tag` holds so entries can swap layers (in-process vs wire)
 * without touching call sites:
 *
 * ```ts
 * class AppClient extends Context.Tag("app/AppClient")<
 *   AppClient,
 *   Domain.Client<typeof domain>
 * >() {}
 * ```
 *
 * `TE` and `R` default to `never` (a fully-provided wire client); pin them
 * to match the layers the tag will be provided with.
 *
 * @since 0.1.0
 * @category models
 */
export type Client<D, TE = never, R = never> =
  D extends DomainInstance<infer Ops, infer _P, infer _PE, infer _PR>
    ? WireClient<Ops, TE, R>
    : never;

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
 * The one-argument form is the in-process client: the transport is
 * `handleDispatch` / `handleSubscription` on the same instance, so every
 * call still round-trips the wire codec (encode → decode in memory) and is
 * typed identically to the remote client — the server side of an app can
 * run the exact calls the browser side runs. Its error channel carries the
 * domain's `ProvidedE` and its `R` the domain's unprovided services.
 *
 * @since 0.1.0
 * @category constructors
 */
export function client<Ops extends Record<string, AnyOperationDef>, Provided, ProvidedE, ProvidedR>(
  dom: DomainInstance<Ops, Provided, ProvidedE, ProvidedR> & RequireErrorSchemas<Ops>,
): WireClient<Ops, ProvidedE, Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR>;
export function client<
  Ops extends Record<string, AnyOperationDef>,
  Provided,
  ProvidedE,
  ProvidedR,
  TE,
>(
  dom: DomainInstance<Ops, Provided, ProvidedE, ProvidedR> & RequireErrorSchemas<Ops>,
  transport: WireTransport<TE>,
): WireClient<Ops, TE>;
export function client<
  Ops extends Record<string, AnyOperationDef>,
  Provided,
  ProvidedE,
  ProvidedR,
  TE,
>(
  dom: DomainInstance<Ops, Provided, ProvidedE, ProvidedR> & RequireErrorSchemas<Ops>,
  maybeTransport?: WireTransport<TE>,
): WireClient<Ops, TE> {
  const transport: WireTransport<TE> =
    maybeTransport ??
    ({
      execute: (request: DispatchRequest) => dom.handleDispatch(request),
      subscribe: (request: DispatchRequest) => dom.handleSubscription(request),
      // In-process transport: TE/R live on the effects, not the interface —
      // the overload's return type restores them.
    } as unknown as WireTransport<TE>);
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

  const executeOne = (name: string, config: { args?: unknown; select?: unknown }) =>
    transport
      .execute({ name, args: config.args, select: config.select })
      .pipe(Effect.flatMap(decode(name, config.select)), Effect.flatMap(unwrap));

  // The generic surface below is untyped by construction (runtime name
  // strings); the WireClient interface restores exact `domain.execute` typing.
  return {
    execute: (
      entryOrEntries:
        | { readonly name: string; args?: unknown; select?: unknown }
        | ReadonlyArray<{ readonly name: string; args?: unknown; select?: unknown }>,
    ) =>
      Array.isArray(entryOrEntries)
        ? Effect.all(
            entryOrEntries.map((entry) => executeOne(entry.name, entry)),
            { concurrency: "unbounded" },
          )
        : // Array.isArray doesn't narrow ReadonlyArray out of the union.
          executeOne(
            (entryOrEntries as { readonly name: string }).name,
            entryOrEntries as { args?: unknown; select?: unknown },
          ),
    subscribe: (entry: { readonly name: string; args?: unknown; select?: unknown }) => {
      const name = entry.name;
      const cfg = entry;
      return transport
        .subscribe({ name, args: cfg.args, select: cfg.select })
        .pipe(
          Stream.mapEffect((item) => decode(name, cfg.select)(item).pipe(Effect.flatMap(unwrap))),
        );
    },
  } as unknown as WireClient<Ops, TE>;
}
