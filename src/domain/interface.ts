import type { Effect, Layer, Result, Schema, Stream } from "effect";
import type { AnyOperationDef } from "../define.ts";
import type {
  DispatchOptions,
  DispatchRequest,
  GatewayError,
  OperationError,
  WireDispatchOptions,
} from "../gateway.ts";
import type { Inspection } from "../inspect.ts";
import type { DomainTopology } from "./topology.ts";
import type { Invocation, InvocationKeyOptions } from "../invocation-key.ts";
import type { SelectionAnalysis } from "../selection/analyze.ts";
import type { RootSelectionFor } from "../selection/index.ts";
import type { Selection } from "../selection/syntax.ts";
import type * as DomainTypes from "./type-level.ts";

export type RuntimeBindConfig = Readonly<
  Record<string, { readonly to?: string; readonly select?: Selection }>
>;

export interface PreparedDispatch<ProvidedR = never, E = unknown, ProvidedE = never> {
  readonly name: string;
  readonly args: unknown;
  readonly select?: Selection;
  readonly invocationKey: string;
  readonly analysis: SelectionAnalysis;
  /**
   * Operation E and gateway errors surface inside the Result value; the
   * Effect error channel carries only `ProvidedE` — failures acquiring
   * layers applied via `provide()`, which happen outside the boundary
   * lifting and cannot be encoded into the envelope.
   */
  execute(
    options?: DispatchOptions,
  ): Effect.Effect<Result.Result<unknown, GatewayError | OperationError<E>>, ProvidedE, ProvidedR>;
}

export interface DomainInstance<
  Ops extends Record<string, AnyOperationDef>,
  Provided = never,
  ProvidedE = never,
  ProvidedR = never,
> {
  /**
   * Type-level witness consumed by `Domain.Erasable` / `Domain.erase` —
   * carries the services still unprovided after `provide()` calls. Never
   * present at runtime.
   */
  readonly "~effect-domain"?:
    | {
        readonly missingServices: Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR;
      }
    | undefined;
  readonly operations: Ops;
  operationNames(): ReadonlyArray<DomainTypes.OperationNamesByStream<Ops, false>>;
  subscriptionNames(): ReadonlyArray<DomainTypes.OperationNamesByStream<Ops, true>>;
  analyzeSelection(selection?: Selection): SelectionAnalysis;
  /**
   * Array form: execute several operations as one call —
   * `execute([{ name: "getUser", args, select }, { name: "getStats", select }])`
   * — each entry the same shape as a dispatch envelope. Returns a tuple
   * typed per entry, with the error and requirement
   * channels the union of the listed operations'. Entries run concurrently
   * (`options.concurrency`, default unbounded) and share the fiber's
   * request-batching window, so batched fields coalesce across entries.
   * Fail-fast: the first failing entry interrupts its siblings.
   *
   * Must stay declared before the name-based overloads: an array argument
   * can never match the `name` slot, so single-op inference and error
   * messages are unaffected.
   */
  execute<const T extends ReadonlyArray<DomainTypes.ExecuteEntry<Ops>>>(
    entries: T,
    options?: { readonly concurrency?: number | "unbounded" },
  ): Effect.Effect<
    { -readonly [I in keyof T]: DomainTypes.ExecuteEntryResult<Ops, T[I]> },
    DomainTypes.ExecuteEntryE<Ops, T[number]> | ProvidedE,
    Exclude<DomainTypes.ExecuteEntryR<Ops, T[number]>, Provided> | ProvidedR
  >;
  /**
   * Canonical single form: one dispatch-shaped envelope —
   * `execute({ name: "getUser", args, select }, options?)`. The envelope
   * carries only client data (`name`/`args`/`select`); execution policy —
   * walker `concurrency` and the `reads: true` read-set collection — lives
   * in `options`, matching the dispatch philosophy. With `reads: true`,
   * returns an {@link DomainTypes.Execution} envelope with the walk's
   * {@link ReadSet} — the deduplicated `(node, key)` pairs of every
   * identified entity the walk touched (only nodes declaring both a
   * `node()` identifier and an `identity` are recorded); the foundation for
   * sync-engine invalidation, cache tagging, and access auditing.
   *
   * Must stay declared after the array overload: an array can never match
   * the envelope slot, so inference and error messages are unaffected.
   */
  execute<const T extends DomainTypes.ExecuteEntry<Ops>>(
    entry: T,
    options: { readonly reads: true; readonly concurrency?: number | "unbounded" },
  ): Effect.Effect<
    DomainTypes.Execution<DomainTypes.ExecuteEntryResult<Ops, T>>,
    DomainTypes.ExecuteEntryE<Ops, T> | ProvidedE,
    Exclude<DomainTypes.ExecuteEntryR<Ops, T>, Provided> | ProvidedR
  >;
  execute<const T extends DomainTypes.ExecuteEntry<Ops>>(
    entry: T,
    options?: { readonly reads?: false; readonly concurrency?: number | "unbounded" },
  ): Effect.Effect<
    DomainTypes.ExecuteEntryResult<Ops, T>,
    DomainTypes.ExecuteEntryE<Ops, T> | ProvidedE,
    Exclude<DomainTypes.ExecuteEntryR<Ops, T>, Provided> | ProvidedR
  >;
  /**
   * Canonical subscription form: one dispatch-shaped envelope —
   * `subscribe({ name: "watchUser", args, select })`. Walker `concurrency`
   * (per streamed item) is execution policy and lives in `options`.
   */
  subscribe<const T extends DomainTypes.SubscribeEntry<Ops>>(
    entry: T,
    options?: { readonly concurrency?: number | "unbounded" },
  ): Stream.Stream<
    DomainTypes.ExecuteEntryResult<Ops, T>,
    DomainTypes.ExecuteEntryE<Ops, T> | ProvidedE,
    Exclude<DomainTypes.ExecuteEntryR<Ops, T>, Provided> | ProvidedR
  >;
  inspect(): Inspection;
  /**
   * The graph's domain topology as a core `effect/Graph` value — one node
   * per registered `node()`, one edge per field reference — with Mermaid and
   * GraphViz export. Built once per graph and memoized.
   */
  topology(): DomainTopology;
  /**
   * Returns the runtime args Decoder for an operation. Lazy + memoized per
   * operation.
   *
   * For ops without an `args` field, returns a decoder that accepts both
   * `undefined` and `{}` and decodes both to `undefined` — matching `dispatch`'s
   * empty-args normalization, so external callers composing `argsSchema`
   * directly stay in lockstep with the boundary's behavior.
   *
   * Returns a {@link Schema.Decoder} (not `Schema`) so `decodeUnknownEffect`
   * produces `Effect<…, Issue, never>` — the args slot disallows
   * service-requiring decoders, so `R = never` is sound.
   *
   * Throws synchronously if `name` is not an operation on this graph — the
   * accessor is sync because Schemas are values, not Effects.
   */
  argsSchema<K extends string & keyof Ops>(
    name: K,
  ): Schema.Decoder<DomainTypes.ExtractArgs<Ops[K]>>;
  /**
   * Returns the operation's declared error schema (`operation({ error })`),
   * or `Schema.Never` when none was declared.
   *
   * The returned codec is typed against the resolver's failure type `E`
   * directly: `operation()` guarantees at definition time that a declared
   * schema's `Type` covers `E`. Services are asserted `never`, matching the
   * boundary convention of `responseSchema` — declared error schemas are
   * plain data schemas.
   * Operations that fail (`E` not `never`) without a declared schema fall
   * back to `Schema.Never` — typed as `Codec<never>`, honestly: such a codec
   * cannot encode their failures. Declare an `error` schema on any operation
   * whose errors must cross a wire; `Domain.MissingErrorSchemas` turns the
   * omission into a compile error at adapter boundaries.
   *
   * This is the *operation-declared* schema only. The wire failure codecs
   * additionally union in every reachable field's declared error schema — an
   * adapter composing its own failure codec should do the same via
   * `reachableFieldErrorSchemas(registry, rootAst)`.
   *
   * Throws synchronously if `name` is not an operation on this graph.
   */
  errorSchema<K extends string & keyof Ops>(
    name: K,
  ): Schema.Codec<DomainTypes.DeclaredErrorType<Ops[K]>, unknown, never, never>;
  /**
   * Returns the runtime selection Schema mirroring
   * `RootSelectionFor<Op["type"]>` for an operation. Built lazily on first
   * call, memoized per operation.
   *
   * Throws synchronously if `name` is unknown, or if a non-sentinel-
   * discriminated union is reachable from the operation's node tree (the
   * walker can't dispatch one, so the boundary couldn't either). Through
   * `dispatch`/`dispatchSubscription` the throw becomes a defect via `Effect.suspend`.
   */
  selectionSchema<K extends string & keyof Ops>(
    name: K,
  ): Schema.Codec<
    RootSelectionFor<DomainTypes.ExtractType<Ops[K]>> | undefined,
    unknown,
    never,
    never
  >;
  /**
   * Returns a runtime Schema for the exact response shape produced by an
   * operation and a validated root selection: the plain selected tree, with
   * the wire JSON on the encoded side. This is the success half of the codec
   * `Domain.client` decodes with — the same cached object —
   * so a value from `execute` conforms by construction. Use it wherever a
   * projection needs a schema value rather than just a type: UI state
   * containers, persistence, hydration payloads, fixture validation.
   *
   * Response schemas are memoized by operation AST and canonicalized selection.
   * Prefer using this for fixed or already-validated selections during adapter
   * setup. Dynamic gateways that call this for arbitrary user-controlled
   * selections should bound or reuse selections at the adapter layer.
   */
  responseSchema<
    K extends string & keyof Ops,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>> | undefined,
  >(
    name: K,
    selection?: S,
  ): Schema.Codec<
    DomainTypes.DomainRootSelectedOf<DomainTypes.ExtractType<Ops[K]>, S>,
    unknown,
    never,
    never
  >;
  /**
   * Returns a runtime Schema for the full `dispatch` result wire shape:
   * `Result<responseSchema(name, selection), GatewayError | OperationError<E>>`.
   *
   * The graph derives the success schema from the operation and selection.
   * The error cause schema is the operation's declared `error` (see
   * {@link errorSchema}) unioned with every reachable field's declared
   * `error` — a field's typed failure fails the whole operation, so its
   * schema belongs to the cause union. Passing `operationErrorSchema`
   * overrides only the operation-declared part; field error schemas are
   * always unioned in.
   */
  dispatchResultSchema<
    K extends DomainTypes.OperationNamesByStream<Ops, false>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>> | undefined,
    F extends Schema.Top,
  >(
    name: K,
    selection: S,
    operationErrorSchema: F,
  ): Schema.Codec<
    Result.Result<
      DomainTypes.DomainRootSelectedOf<DomainTypes.ExtractType<Ops[K]>, S>,
      GatewayError | OperationError<F["Type"] | DomainTypes.OperationFieldWireE<Ops[K]>>
    >,
    unknown,
    F["DecodingServices"],
    F["EncodingServices"]
  >;
  dispatchResultSchema<
    K extends DomainTypes.OperationNamesByStream<Ops, false>,
    const S extends RootSelectionFor<DomainTypes.ExtractType<Ops[K]>> | undefined,
  >(
    name: K,
    selection: S,
  ): Schema.Codec<
    Result.Result<
      DomainTypes.DomainRootSelectedOf<DomainTypes.ExtractType<Ops[K]>, S>,
      GatewayError | OperationError<DomainTypes.OperationWireE<Ops[K]>>
    >,
    unknown,
    never,
    never
  >;
  /**
   * Total, string-accepting sibling of {@link dispatchResultSchema} for
   * dynamic adapters that hold a runtime operation name rather than a typed
   * key (generic RPC/HTTP gateways, codegen).
   *
   * Never throws: when the name is unknown or the selection cannot produce
   * a response codec, it returns a fallback codec whose failure branch
   * decodes the {@link GatewayError} union. That is always sufficient,
   * because any dispatch that would hit those cases fails at the boundary
   * with a GatewayError — the fallback decodes exactly what the server can
   * produce. Subscription names build real codecs: each stream item shares
   * the one-shot dispatch Result wire shape. Success and error causes are
   * wire-erased to `unknown`; use the typed overloads when the operation
   * name is static.
   *
   * The error cause schema is the operation's declared `error` (see
   * {@link errorSchema}) unioned with every reachable field's declared
   * `error`; a dynamic adapter holding only a runtime name has no
   * per-operation override to offer. Use the typed `dispatchResultSchema`
   * to override the operation-declared part explicitly.
   */
  dispatchResultSchemaDynamic(
    name: string,
    selection: Selection | undefined,
  ): Schema.Codec<
    Result.Result<unknown, GatewayError | OperationError<unknown>>,
    unknown,
    never,
    never
  >;
  /**
   * Freezes operation names and selections into ordinary typed service
   * methods. Use this for application composition and fixed host-framework
   * routes/procedures; use `dispatch` for dynamic runtime invocations.
   */
  bind<const Config extends RuntimeBindConfig>(
    config: Config & DomainTypes.ValidateBindConfig<Ops, Config, false>,
  ): DomainTypes.BoundOperations<Ops, Config, Provided, ProvidedE, ProvidedR>;
  /**
   * Subscription sibling of `bind`.
   */
  bindSubscriptions<const Config extends RuntimeBindConfig>(
    config: Config & DomainTypes.ValidateBindConfig<Ops, Config, true>,
  ): DomainTypes.BoundSubscriptions<Ops, Config, Provided, ProvidedE, ProvidedR>;
  /**
   * Array form: dispatch several envelopes as one call. Returns the
   * per-envelope outcomes in entry order — each element is the same
   * `Result` the single form produces, so one entry's failure sits in its
   * own `Result` while siblings succeed (no fail-fast). Entries run
   * concurrently (unbounded) in one fiber tree, sharing the request-batching
   * window; `options` are the per-envelope {@link DispatchOptions} applied
   * to every entry (`concurrency` is each entry's walker concurrency, not a
   * batch limit).
   *
   * Must stay declared before the single-envelope overload: an array
   * argument can never match the object form, so single-form inference and
   * error messages are unaffected.
   */
  dispatch(
    configs: ReadonlyArray<DispatchRequest>,
    options?: DispatchOptions,
  ): Effect.Effect<
    ReadonlyArray<
      Result.Result<unknown, GatewayError | OperationError<DomainTypes.AllE<Ops> | ProvidedE>>
    >,
    ProvidedE,
    Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR
  >;
  /**
   * Convenience gateway entry for decoded or server-constructed dynamic
   * invocations. Decodes operation args + select and immediately executes the
   * operation. All expected outcomes (boundary errors AND operation E) surface
   * as Result.failure values wrapped in GatewayError or OperationError<E>. The
   * Effect failure channel carries only `ProvidedE` (layer acquisition
   * failures — `never` for infallible layers); everything else expected is in
   * the Result, and only defects die.
   *
   * For untrusted transports that need pre-execution policy checks, prefer
   * `decodeDispatchRequest` (when the whole invocation is raw data) followed by
   * `prepareDispatch`, then run `prepared.execute(...)` only after auth,
   * depth/field limits, caching, rate limits, or audit policy pass.
   *
   * Pipe through Domain.orFail to move OperationError<E> into the Effect failure
   * channel when that split is useful (HTTP 4xx vs 5xx, Rpc handlers).
   *
   * The envelope carries only client data; walker concurrency is server
   * policy, passed via `options` at the dispatch site. Adapters that want to
   * honor a client-supplied limit read it from their own protocol and pass it
   * here explicitly.
   */
  dispatch(
    config: DispatchRequest,
    options?: DispatchOptions,
  ): Effect.Effect<
    Result.Result<unknown, GatewayError | OperationError<DomainTypes.AllE<Ops> | ProvidedE>>,
    ProvidedE,
    Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR
  >;
  /**
   * Decodes and analyzes a dynamic operation invocation without running any
   * operation or field resolvers. This is the recommended production gateway
   * path for untrusted input: validate the envelope with `decodeDispatchRequest`
   * if needed, call `prepareDispatch`, enforce allowlists, depth/field limits,
   * auth policy, caching, rate limits, or audit logging, then call
   * `prepared.execute(...)`. The returned prepared dispatch reuses the decoded
   * args/select when executed. Pass `options.bytes` to increase the prepared
   * invocation key length for durable/global idempotency stores.
   */
  prepareDispatch(
    config: DispatchRequest,
    options?: InvocationKeyOptions,
  ): Effect.Effect<
    PreparedDispatch<
      Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR,
      DomainTypes.AllE<Ops> | ProvidedE,
      ProvidedE
    >,
    GatewayError
  >;
  /**
   * Subscription sibling of `dispatch`. Returns the stream directly (not
   * `Effect<Stream<…>>`); boundary parse failures emit as the first and only
   * `Result.failure` element via `Stream.unwrap`. Operation E is promoted to
   * `Result.failure(OperationError(...))`; the stream E channel carries only
   * `ProvidedE` (layer acquisition failures — `never` for infallible layers).
   *
   * Pipe through Domain.orFailStream to move OperationError<E> into the stream
   * E channel.
   */
  dispatchSubscription(
    config: DispatchRequest,
    options?: DispatchOptions,
  ): Stream.Stream<
    Result.Result<unknown, GatewayError | OperationError<DomainTypes.AllE<Ops> | ProvidedE>>,
    ProvidedE,
    Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR
  >;
  /**
   * Array form: handle several dispatch envelopes as one call. Returns the
   * encoded dispatch-Result envelopes in entry order — each element is the
   * same wire envelope the single form produces, so one entry's failure is
   * encoded inside its own envelope while siblings succeed, and the error
   * channel stays `ProvidedE`. Entries run concurrently (unbounded) in one
   * fiber tree, sharing the request-batching window; `options` are the
   * per-envelope {@link WireDispatchOptions} applied to every entry.
   *
   * Must stay declared before the single-envelope overload: an array
   * argument can never match the object form, so single-form inference and
   * error messages are unaffected.
   */
  handleDispatch(
    this: DomainTypes.RequireErrorSchemas<Ops>,
    configs: ReadonlyArray<DispatchRequest>,
    options?: WireDispatchOptions,
  ): Effect.Effect<
    ReadonlyArray<unknown>,
    ProvidedE,
    Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR
  >;
  /**
   * The complete server-side wire pipeline for one dynamic invocation:
   * `dispatch(config)` encoded with
   * `dispatchResultSchemaDynamic(config.name, config.select)`. The returned
   * value is the encoded dispatch-Result envelope
   * (`{ _tag: "Success", success } | { _tag: "Failure", failure }`), ready to
   * serialize onto any transport; a client decodes it with the same codec.
   *
   * All expected outcomes — gateway errors and operation E — are inside the
   * envelope's Failure branch. The Effect error channel carries only
   * `ProvidedE`: failures acquiring layers applied via `provide()`, which
   * happen outside the boundary lifting and cannot be encoded into the
   * envelope (`never` for infallible layers). An encode failure means the
   * domain produced a result its own codec rejects (a graph invariant
   * violation) and dies.
   *
   * Serializing failures requires every fallible operation to declare an
   * `error` schema: the `this` parameter enforces
   * {@link DomainTypes.RequireErrorSchemas} at the call site, naming any
   * operation missing one. Options are {@link WireDispatchOptions} —
   * `reads` is excluded because the read-set envelope cannot round-trip
   * the wire codec.
   *
   * This is the top rung of the dispatch ladder: use `handleDispatch` for
   * simple transports, `prepareDispatch` when policy (auth, limits, caching)
   * must run between validation and execution, and `dispatch` when nothing
   * crosses a wire and live `Result` values are wanted.
   *
   * @since 0.1.0
   */
  handleDispatch(
    this: DomainTypes.RequireErrorSchemas<Ops>,
    config: DispatchRequest,
    options?: WireDispatchOptions,
  ): Effect.Effect<unknown, ProvidedE, Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR>;
  /**
   * Subscription sibling of {@link handleDispatch}: `dispatchSubscription`
   * with every emitted item encoded through the same dynamic wire codec.
   * Each stream element is one encoded dispatch-Result envelope — the same
   * shape `handleDispatch` produces — so subscription items and one-shot
   * responses share a single client decode path. Enforces
   * {@link DomainTypes.RequireErrorSchemas} the same way.
   *
   * @since 0.1.0
   */
  handleSubscription(
    this: DomainTypes.RequireErrorSchemas<Ops>,
    config: DispatchRequest,
    options?: WireDispatchOptions,
  ): Stream.Stream<unknown, ProvidedE, Exclude<DomainTypes.AllR<Ops>, Provided> | ProvidedR>;
  /**
   * Canonical truncated SHA-256 over `(name, args, select)`. Stable across key
   * order, `[true]` ↔ `true`, multi-alias entry order, and empty `select: {}`
   * blocks. Defaults to 8 bytes / 16 hex chars for compact cache keys; use 16
   * or 32 bytes for durable/global idempotency keys.
   */
  invocationKey(invocation: Invocation, options?: InvocationKeyOptions): string;
  /**
   * Structural equality on two selections, matching `invocationKey`'s notion
   * of equality. Cheaper than hashing — use this for in-process comparison.
   */
  selectionsEqual(a: unknown, b: unknown): boolean;
  /**
   * Pre-applies a layer to all operations in this graph, narrowing R for
   * subsequent execute() / subscribe() calls. Layers are stored on the Domain
   * wrapper and applied at execute-time so they cover BOTH the operation
   * resolver AND every field resolver reached by the walker.
   *
   * **Layer lifetime: services are constructed per call.** Each
   * `execute`/`subscribe`/`dispatch`/`prepared.execute()` run builds the
   * layer, runs, and releases — finalizers run at the end of every call
   * (`prepareDispatch` itself only decodes; layers apply when its `execute`
   * runs). That is the right semantics for cheap or per-request-scoped layers
   * (auth context, request loggers, tests), and the wrong cost model for
   * expensive shared resources (database pools, connection caches). For
   * those, build the context once in your app scope and provide the prebuilt
   * context:
   *
   * ```ts
   * const app = Effect.gen(function* () {
   *   const context = yield* Layer.build(AppLayer); // built once, scoped
   *   const g = graph.provide(Layer.succeedContext(context));
   *   // every g.execute()/g.dispatch() reuses the same services;
   *   // finalizers run when the surrounding scope closes
   * });
   * Effect.scoped(app);
   * ```
   *
   * The prebuilt context is only valid inside that scope: a graph that
   * escapes it holds references to already-finalized services. Keep the
   * graph's use within the scope that built the context.
   *
   * Provide is independent of merge: spreading `operations` into a new
   * `Domain.make({ ...a.operations, ...b.operations })` strips the layers
   * stored on `a` and `b`. To compose two layered subgraphs, merge the
   * operations first, then provide once with `Layer.merge(L1, L2)`.
   *
   * Multiple `provide()` calls compose; each subsequent layer wraps the
   * previous, so a later layer can satisfy an earlier layer's `RIn`.
   */
  provide<AL, EL = never, RL = never>(
    layer: Layer.Layer<AL, EL, RL>,
  ): DomainInstance<Ops, Provided | AL, ProvidedE | EL, Exclude<ProvidedR, AL> | RL>;
}
