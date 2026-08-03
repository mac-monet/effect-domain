import { Effect, Result, Stream } from "effect";
import type { Schema } from "effect";
import type { AnyOperationDef } from "../define.ts";
import type { Inspection } from "../inspect.ts";
import {
  decodeDispatchPayload as decodePayload,
  decodeDispatchRequest as decodeRequest,
  DispatchPayloadSchema,
  DispatchRequestSchema,
  type GatewayError,
  OperationError,
} from "../gateway.ts";
import type { DomainInstance } from "./interface.ts";
import { makeDomain } from "./runtime.ts";
import type * as DomainTypes from "./type-level.ts";
import * as WireClientModule from "./wire-client.ts";

export type { DomainInstance, PreparedDispatch } from "./interface.ts";

/**
 * The graph namespace: {@link Domain.make} plus the result-type helpers and
 * gateway utilities that operate on a graph from the outside.
 *
 * @since 0.1.0
 * @category constructors
 */
export namespace Domain {
  /**
   * Config accepted by `graph.execute` / `graph.subscribe` for a given
   * operation: `args`, `select`, and walker `concurrency`.
   *
   * @since 0.1.0
   * @category models
   */
  export type ExecuteConfig<T, Args, S> = DomainTypes.DomainExecuteConfig<T, Args, S>;
  /**
   * The operation names whose resolvers can fail (`E` is not `never`) but
   * that declared no `error` schema. Adapters that serialize failures
   * constrain on `[MissingErrorSchemas<Ops>] extends [never]` so a missing
   * declaration becomes a compile error at the adapter boundary — domains
   * used purely via `execute()` never pay for schemas they don't need.
   *
   * @since 0.3.0
   * @category models
   */
  export type MissingErrorSchemas<Ops extends Record<string, AnyOperationDef>> =
    DomainTypes.MissingErrorSchemas<Ops>;
  /**
   * The wire-level error type for an operation: the declared error schema's
   * `Type` when one exists, else the resolver's inferred failure type.
   *
   * @since 0.3.0
   * @category models
   */
  export type DeclaredErrorType<Op extends AnyOperationDef> = DomainTypes.DeclaredErrorType<Op>;
  /**
   * Constraint for adapter entry points that serialize failures: satisfied
   * only when every fallible operation declared an `error` schema, otherwise
   * a compile error naming the operations. Apply at the adapter boundary,
   * never at `Domain.make`. See {@link Domain.wireClient}.
   *
   * @since 0.3.0
   * @category models
   */
  export type RequireErrorSchemas<Ops extends Record<string, AnyOperationDef>> =
    WireClientModule.RequireErrorSchemas<Ops>;
  /**
   * What {@link Domain.wireClient} needs from a transport: send one dispatch
   * envelope, return the raw response produced by `handleDispatch` /
   * `handleSubscription` on the server. `TE` is the transport's own failure
   * type and flows into the typed client's error channel.
   *
   * @since 0.3.0
   * @category models
   */
  export type WireTransport<TE> = WireClientModule.WireTransport<TE>;
  /**
   * A remote client with `domain.execute` / `domain.subscribe` parity,
   * produced by {@link Domain.wireClient}.
   *
   * @since 0.3.0
   * @category models
   */
  export type WireClient<
    Ops extends Record<string, AnyOperationDef>,
    TE = never,
  > = WireClientModule.WireClient<Ops, TE>;
  /**
   * Envelope returned by `execute(name, { ..., reads: true })`: the
   * operation result plus per-execution artifacts (currently the walk's
   * read set).
   *
   * @since 0.2.0
   * @category models
   */
  export type Execution<A> = DomainTypes.Execution<A>;
  /**
   * Result tree for type `T` narrowed by selection `S` — what a projected
   * node resolves to.
   *
   * @since 0.1.0
   * @category models
   */
  export type ResultOf<T, S> = DomainTypes.DomainResultOf<T, S>;
  /**
   * Operation-root result for root type `T` and selection `S`: projected
   * trees for object roots, arrays of trees for array roots, `Option` for
   * nullable roots, and the raw value for opaque roots.
   *
   * @since 0.1.0
   * @category models
   */
  export type RootResultOf<T, S> = DomainTypes.DomainRootResultOf<T, S>;
  /**
   * Picks from `T` only the fields present in selection `S`, recursing
   * through nested `select` blocks.
   *
   * @since 0.1.0
   * @category models
   */
  export type NarrowBySelection<T, S> = DomainTypes.DomainNarrowBySelection<T, S>;
  /**
   * Wraps every field of `T` in `Result.Result` — the per-field isolation
   * the walker guarantees.
   *
   * @since 0.1.0
   * @category models
   */
  export type ResultTree<T> = DomainTypes.DomainResultTree<T>;

  /**
   * Wire schema for a name-less invocation payload (`{ args?, select? }`),
   * for transports that carry the operation name out-of-band (e.g. in the
   * URL path).
   *
   * @since 0.1.0
   * @category schemas
   */
  export const DispatchPayload = DispatchPayloadSchema;
  /**
   * Wire schema for a full invocation envelope (`{ name, args?, select? }`).
   * Carries client data only — execution policy like concurrency is a
   * server-side `DispatchOptions` concern, never on the wire.
   *
   * @since 0.1.0
   * @category schemas
   */
  export const DispatchRequest = DispatchRequestSchema;
  /**
   * Decodes an untrusted `{ args?, select? }` payload.
   *
   * @since 0.1.0
   * @category decoding
   */
  export const decodeDispatchPayload = decodePayload;
  /**
   * Decodes an untrusted `{ name, args?, select? }` envelope.
   *
   * @since 0.1.0
   * @category decoding
   */
  export const decodeDispatchRequest = decodeRequest;

  /**
   * Lifts `OperationError<E>` out of the Result value channel into the Effect
   * failure channel. Boundary errors (GatewayError) remain as Result.failure.
   * Only defects propagate as defects.
   *
   * Pipe this after `dispatch()` when the transport wants op E in a separate
   * failure path (HTTP 4xx boundary errors, 5xx op errors via Effect.orDie).
   *
   * @example
   * ```ts
   * import { Effect } from "effect"
   * import { Domain } from "effect-domain"
   *
   * const handler = graph
   *   .dispatch({ name: "getUser", args: { id: "1" }, select: { id: true } })
   *   .pipe(Domain.orFail, Effect.orDie) // boundary errors stay in the Result
   * ```
   *
   * @since 0.1.0
   * @category combinators
   */
  export function orFail<A, E, R>(
    self: Effect.Effect<Result.Result<A, GatewayError | OperationError<E>>, never, R>,
  ): Effect.Effect<Result.Result<A, GatewayError>, E, R> {
    return Effect.flatMap(self, (result) =>
      Result.match(result, {
        onSuccess: (success): Effect.Effect<Result.Result<A, GatewayError>, E> =>
          Effect.succeed(Result.succeed(success)),
        onFailure: (failure): Effect.Effect<Result.Result<A, GatewayError>, E> =>
          failure instanceof OperationError
            ? Effect.fail(failure.cause)
            : Effect.succeed(Result.fail(failure)),
      }),
    );
  }

  /**
   * Stream sibling of {@link orFail}. Lifts `OperationError<E>` out of the
   * Result value channel into the Stream failure channel.
   *
   * @since 0.1.0
   * @category combinators
   */
  export function orFailStream<A, E, R>(
    self: Stream.Stream<Result.Result<A, GatewayError | OperationError<E>>, never, R>,
  ): Stream.Stream<Result.Result<A, GatewayError>, E, R> {
    return Stream.mapEffect(self, (result) =>
      Result.match(result, {
        onSuccess: (success): Effect.Effect<Result.Result<A, GatewayError>, E> =>
          Effect.succeed(Result.succeed(success)),
        onFailure: (failure): Effect.Effect<Result.Result<A, GatewayError>, E> =>
          failure instanceof OperationError
            ? Effect.fail(failure.cause)
            : Effect.succeed(Result.fail(failure)),
      }),
    );
  }

  /**
   * The type-erased consumer surface of a fully-provided graph: what an
   * adapter that owns its own wire validation (a GraphQL layer, an RPC
   * bridge) consumes. Names, args, and selections are trusted by
   * construction on this surface — the adapter is expected to have
   * validated them against `inspect()` / `argsSchema` before calling.
   *
   * Obtain one with {@link Domain.erase}; a `DomainInstance` whose services
   * are all provided also satisfies it structurally.
   *
   * @since 0.2.0
   * @category models
   */
  export interface Erased {
    inspect(): Inspection;
    /** Erased `DomainInstance.argsSchema` — throws on unknown names. */
    argsSchema(name: string): Schema.Decoder<unknown>;
    execute(
      name: string,
      config: { readonly args?: unknown; readonly select?: unknown },
    ): Effect.Effect<unknown, unknown>;
    subscribe(
      name: string,
      config: { readonly args?: unknown; readonly select?: unknown },
    ): Stream.Stream<unknown, unknown>;
  }

  /**
   * The services a graph still needs, read from the `~effect-domain`
   * type-level witness. `never` for fully-provided graphs and for values
   * that are already {@link Erased}.
   */
  type MissingServices<D> = D extends {
    readonly "~effect-domain"?: { readonly missingServices: infer M } | undefined;
  }
    ? M
    : never;

  /**
   * Generic constraint for adapter entry points that consume a graph:
   * `function make<D extends Domain.Erasable<D>>(domain: D, ...)`. Satisfied
   * by any {@link DomainInstance} whose services are all provided
   * (`R = never`) and by {@link Erased} values; a graph with unprovided
   * services fails the constraint with the missing services named in the
   * error. `DomainInstance`'s generic overloads cannot structurally satisfy
   * {@link Erased} directly (TypeScript instantiates them to their
   * constraints), so adapters constrain on this and call {@link Domain.erase}
   * to obtain the runtime surface.
   *
   * @since 0.2.0
   * @category models
   */
  export type Erasable<D> = {
    inspect(): Inspection;
    argsSchema(name: never): Schema.Decoder<unknown>;
    execute(name: never, config: never): Effect.Effect<unknown, unknown, unknown>;
    subscribe(name: never, config: never): Stream.Stream<unknown, unknown, unknown>;
  } & ([MissingServices<D>] extends [never]
    ? unknown
    : {
        "effect-domain/unprovided services — provide() these before erasing": MissingServices<D>;
      });

  /**
   * Erases a graph to its adapter-facing surface ({@link Erased}).
   *
   * Compile-time contract: every service must already be provided
   * (`R = never`). A graph with unprovided services fails to type-check
   * here with the missing services named in the error — provide them via
   * `graph.provide(layer)` first. This is the supported way for adapters to
   * drop the operation-level generics without casts.
   *
   * @since 0.2.0
   * @category combinators
   */
  export function erase<D extends Erasable<D>>(domain: D): Erased {
    // The witness carries the R = never evidence for DomainInstances; the
    // erased methods are the same runtime functions with their generics
    // widened (name/config parameters are bivariant method slots). A
    // hand-rolled non-DomainInstance value without the witness is trusted
    // as-is — the guard is for real graphs, not structural fakes.
    return domain as unknown as Erased;
  }

  /**
   * Creates a graph from a record of operations. Operation names are the
   * record keys; the returned {@link DomainInstance} exposes the typed
   * in-process contract (`execute`, `subscribe`) and the gateway contract
   * (`dispatch`, `prepareDispatch`, the runtime schemas, `invocationKey`).
   *
   * Merge graphs by spreading: `Domain.make({ ...a.operations, ...b.operations })`.
   *
   * @example
   * ```ts
   * import { Effect, Schema } from "effect"
   * import { Domain, operation } from "effect-domain"
   *
   * const g = Domain.make({
   *   getUser: operation({
   *     type: User,
   *     args: Schema.Struct({ id: Schema.String }),
   *     resolve: ({ args }) => UserRepo.findById(args.id),
   *   }),
   * })
   *
   * const user = yield* g.execute("getUser", {
   *   args: { id: "1" },
   *   select: { id: true, fullName: true },
   * })
   * ```
   *
   * @since 0.1.0
   * @category constructors
   */
  export function make<const Ops extends Record<string, AnyOperationDef>>(
    ops: Ops,
  ): DomainInstance<Ops> {
    return makeDomain(ops);
  }

  /**
   * Builds the typed client end of the wire from a domain and a transport —
   * the client mirror of `handleDispatch` / `handleSubscription`. The domain
   * supplies decoding and typing; the transport supplies only "how to send".
   * See {@link WireClientModule.wireClient} for the full contract.
   *
   * @since 0.3.0
   * @category constructors
   */
  export const wireClient = WireClientModule.wireClient;
}
