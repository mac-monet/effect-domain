import { Cause, Effect, Exit, Request, RequestResolver, Schema, SchemaAST, Stream } from "effect";

const ComputedFieldsKey = "effect-domain/fieldDefs";
const IdentityKey = "effect-domain/identity";

/**
 * Opaque handle for a computed or batched field definition, as returned by
 * {@link field}. The `Parent`, `_E`, and `_R` parameters are phantom carriers
 * that let `node()` and the walker recover the field's parent, error, and
 * requirement types.
 *
 * @since 0.1.0
 * @category models
 */
export interface FieldDef<Type, Parent = unknown, _E = unknown, _R = unknown> {
  readonly _kind: "computed" | "batched";
  readonly type: Schema.Schema<Type>;
  readonly _parent?: (parent: Parent) => void;
  readonly _error?: () => _E;
  readonly _requirements?: () => _R;
}

interface ComputedFieldDef<Type, Parent, E, R> {
  readonly _kind: "computed";
  readonly type: Schema.Schema<Type>;
  readonly args?: Schema.Decoder<unknown>;
  readonly resolve: (ctx: {
    readonly parent: Parent;
    readonly args: never;
    readonly selections: ReadonlySet<string>;
  }) => Effect.Effect<Type, E, R>;
}

interface BatchedFieldDef<
  Type,
  Parent,
  _E = unknown,
  _R = unknown,
  K extends string | number = string | number,
> {
  readonly _kind: "batched";
  readonly type: Schema.Schema<Type>;
  readonly key: (parent: Parent) => K;
  readonly resolver: RequestResolver.RequestResolver<BatchFieldRequest>;
}

export interface BatchFieldRequest extends Request.Request<unknown, unknown> {
  readonly _tag: "BatchFieldRequest";
  readonly key: string | number;
}

export const BatchFieldRequest = Request.tagged<BatchFieldRequest>("BatchFieldRequest");

export interface AnyFieldDef {
  readonly _kind: "computed" | "batched";
  readonly type: { readonly ast: SchemaAST.AST };
}

type ExtractFieldType<F> = F extends { readonly type: Schema.Schema<infer T> } ? T : never;

/**
 * The `Type` of a schema returned by {@link node}: the struct's data fields
 * merged with the output types of its computed fields. Computed fields are
 * optional in the type — they exist on the value only when selected.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeType<
  Data,
  Computed extends Record<string, { readonly type: Schema.Schema<any> }>,
> = Data & {
  readonly [K in keyof Computed]?: ExtractFieldType<Computed[K]>;
};

/**
 * Configuration for a pure computed field: `resolve` derives a value from the
 * parent. Optional `args` declares a decoder for per-selection arguments;
 * `selections` lists the immediate child field names the caller selected, for
 * data-fetch lookahead.
 *
 * @since 0.1.0
 * @category models
 */
export interface FieldConfig<Type, Parent, E, R, Args = never> {
  readonly type: Schema.Schema<Type>;
  readonly args?: Schema.Decoder<Args>;
  readonly resolve: (ctx: {
    readonly parent: Parent;
    readonly args: Args;
    readonly selections: ReadonlySet<string>;
  }) => Effect.Effect<Type, E, R>;
}

/**
 * Configuration for a batched data-fetching field: `key` extracts a batch key
 * from the parent and `resolve` receives all keys requested in the current
 * scheduler tick, returning a map of results. The walker batches via
 * `Effect.request`, so 50 parents needing the same field become one `resolve`
 * call. A missing key becomes an individual field failure.
 *
 * @since 0.1.0
 * @category models
 */
export interface BatchedFieldConfig<Type, Parent, E, R, K extends string | number> {
  readonly type: Schema.Schema<Type>;
  readonly key: (parent: Parent) => K;
  readonly resolve: (keys: ReadonlyArray<K>) => Effect.Effect<ReadonlyMap<K, Type>, E, R>;
}

function makeComputedField(
  config: FieldConfig<unknown, unknown, unknown, unknown, unknown>,
): ComputedFieldDef<unknown, unknown, unknown, unknown> {
  return {
    _kind: "computed",
    type: config.type,
    ...(config.args !== undefined ? { args: config.args } : {}),
    resolve: config.resolve,
  };
}

function makeBatchedField(
  config: BatchedFieldConfig<unknown, unknown, unknown, unknown, string | number>,
): BatchedFieldDef<unknown, unknown, unknown, unknown> {
  // R is erased in StoredBatchedFieldDef — narrow to R=never for the resolver
  const resolve = config.resolve as (
    keys: ReadonlyArray<string | number>,
  ) => Effect.Effect<ReadonlyMap<string | number, unknown>, unknown, never>;
  const resolver = RequestResolver.make<BatchFieldRequest>((entries, _key) => {
    const keys = entries.map((e) => e.request.key);
    return Effect.matchEffect(resolve(keys), {
      onSuccess: (resultMap) =>
        Effect.sync(() => {
          for (const entry of entries) {
            if (resultMap.has(entry.request.key)) {
              entry.completeUnsafe(Exit.succeed(resultMap.get(entry.request.key)));
            } else {
              entry.completeUnsafe(
                Exit.fail(
                  new Cause.NoSuchElementError(`Batched field missing key: ${entry.request.key}`),
                ),
              );
            }
          }
        }),
      onFailure: (error) =>
        Effect.sync(() => {
          for (const entry of entries) {
            entry.completeUnsafe(Exit.fail(error));
          }
        }),
    });
  });
  return {
    _kind: "batched",
    type: config.type,
    key: config.key,
    resolver,
  };
}

/**
 * Defines a computed field to attach to a {@link node}. Two modes,
 * discriminated by the presence of `key`: a pure computation resolving from
 * the parent, or a batched data fetch coalescing concurrent requests.
 *
 * Prefer the `node()` factory callback (`f.field(...)`) — it pre-binds the
 * parent type so both modes infer without annotations.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { field } from "effect-domain"
 *
 * // Pure computation
 * const fullName = field({
 *   type: Schema.String,
 *   resolve: ({ parent }: { parent: { first: string; last: string } }) =>
 *     Effect.succeed(`${parent.first} ${parent.last}`),
 * })
 *
 * // Batched data fetch: one resolve call per scheduler tick
 * const postCount = field({
 *   type: Schema.Number,
 *   key: (parent: { id: string }) => parent.id,
 *   resolve: (ids) =>
 *     Effect.succeed(new Map(ids.map((id) => [id, id.length]))),
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export function field<Type, Parent, E, R, Args = never>(
  config: FieldConfig<Type, Parent, E, R, Args>,
): FieldDef<Type, Parent, E, R>;
export function field<Type, Parent, E, R, K extends string | number>(
  config: BatchedFieldConfig<Type, Parent, E, R, K>,
): FieldDef<Type, Parent, E, R>;
export function field(
  config:
    | FieldConfig<unknown, unknown, unknown, unknown, unknown>
    | BatchedFieldConfig<unknown, unknown, unknown, unknown, string | number>,
):
  | ComputedFieldDef<unknown, unknown, unknown, unknown>
  | BatchedFieldDef<unknown, unknown, unknown, unknown> {
  if ("key" in config) {
    return makeBatchedField(config);
  }
  return makeComputedField(config);
}

export type StoredFieldDef<R> = StoredComputedFieldDef<R> | StoredBatchedFieldDef;

export interface StoredComputedFieldDef<R> {
  readonly _kind: "computed";
  readonly type: { readonly ast: SchemaAST.AST };
  readonly args?: Schema.Decoder<unknown>;
  readonly resolve: (ctx: {
    readonly parent: unknown;
    readonly args?: unknown;
    readonly selections: ReadonlySet<string>;
  }) => Effect.Effect<unknown, unknown, R>;
}

export interface StoredBatchedFieldDef {
  readonly _kind: "batched";
  readonly type: { readonly ast: SchemaAST.AST };
  readonly key: (parent: unknown) => string | number;
  readonly resolver: RequestResolver.RequestResolver<BatchFieldRequest>;
}

export function getFieldDefs<R = never>(
  ast: SchemaAST.AST,
): Record<string, StoredFieldDef<R>> | undefined {
  return SchemaAST.resolveAt<Record<string, StoredFieldDef<R>>>(ComputedFieldsKey)(ast);
}

type AnyFieldDefFor<Parent> = FieldDef<unknown, Parent, unknown, unknown>;

/**
 * Options for {@link node}. `identity` declares the node's canonical entity
 * key: either the name of a data field whose value identifies the entity, or
 * a function deriving the key from a node value. Consumers (registries, sync
 * engines, caches) use it to address entities of this node type.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeOptions<T> {
  readonly identity?: ((value: T) => string) | (keyof T & string);
}

/** Stored, type-erased form of {@link NodeOptions.identity}. */
export interface StoredIdentity {
  readonly field: string | undefined;
  readonly extract: (value: unknown) => string;
}

export function getNodeIdentity(ast: SchemaAST.AST): StoredIdentity | undefined {
  return SchemaAST.resolveAt<StoredIdentity>(IdentityKey)(ast);
}

/**
 * Defines a graph node: an Effect Schema struct with computed fields grafted
 * on. The result is still a Schema — its `Type` merges data fields with
 * computed-field outputs (see {@link NodeType}), and the walker resolves
 * selected computed fields on demand.
 *
 * `node()` is a finalizer: schema composition (extend, pick, spread) drops
 * annotations, so call it last. The callback form pre-types the parent for
 * inference-friendly field definitions.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { node } from "effect-domain"
 *
 * const User = node(
 *   "User",
 *   Schema.Struct({ id: Schema.String, first: Schema.String, last: Schema.String }),
 *   (f) => ({
 *     fullName: f.field({
 *       type: Schema.String,
 *       resolve: ({ parent }) => Effect.succeed(`${parent.first} ${parent.last}`),
 *     }),
 *   }),
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export function node<
  Fields extends Record<string, Schema.Schema<unknown>>,
  C extends Record<string, AnyFieldDefFor<Schema.Schema.Type<Schema.Struct<Fields>>>>,
>(
  identifier: string,
  struct: Schema.Struct<Fields>,
  computed: C | ((f: FieldFactory<Schema.Schema.Type<Schema.Struct<Fields>>>) => C),
  options?: NodeOptions<Schema.Schema.Type<Schema.Struct<Fields>>>,
): Schema.Schema<NodeType<Schema.Schema.Type<Schema.Struct<Fields>>, C>> {
  const fields =
    typeof computed === "function"
      ? computed(makeFieldFactory<Schema.Schema.Type<Schema.Struct<Fields>>>())
      : computed;

  const identity = options?.identity;
  const storedIdentity: StoredIdentity | undefined =
    identity === undefined
      ? undefined
      : typeof identity === "string"
        ? {
            field: identity,
            extract: (value) => {
              const key = (value as Record<string, unknown>)[identity];
              // Silent coercion would collide entity keys on "undefined" /
              // "[object Object]" — poison for idempotency stores. Defect.
              if (
                key == null ||
                (typeof key !== "string" && typeof key !== "number" && typeof key !== "bigint")
              ) {
                throw new Error(
                  `node("${identifier}") identity field "${identity}" must resolve to a string, number, or bigint; got ${key === null ? "null" : typeof key}`,
                );
              }
              return String(key);
            },
          }
        : {
            field: undefined,
            extract: identity as (value: unknown) => string,
          };

  // Soundness: annotations preserve the underlying struct codec at runtime; the
  // widened schema type exposes the computed-field result surface that the
  // walker can resolve from the stored field definitions.
  return struct.annotate({
    identifier,
    [ComputedFieldsKey]: fields,
    ...(storedIdentity !== undefined ? { [IdentityKey]: storedIdentity } : {}),
  }) as unknown as Schema.Schema<NodeType<Schema.Schema.Type<Schema.Struct<Fields>>, C>>;
}

interface FieldFactory<Parent> {
  field<Type, E, R, Args = never>(
    config: FieldConfig<Type, Parent, E, R, Args>,
  ): FieldDef<Type, Parent, E, R>;
  field<Type, E, R, K extends string | number>(
    config: BatchedFieldConfig<Type, Parent, E, R, K>,
  ): FieldDef<Type, Parent, E, R>;
}

function makeFieldFactory<Parent>(): FieldFactory<Parent> {
  return { field } as FieldFactory<Parent>;
}

export interface AnyOperationDef {
  readonly _stream: boolean;
  readonly type: { readonly ast: SchemaAST.AST };
  /**
   * Erased Decoder. The slot is narrowed to `Schema.Decoder<unknown>` (not just
   * `{ ast }`) so `argsSchemaFor`'s boundary cast is trivially sound — any
   * future op constructor that lands a value in `args` must also land a
   * Decoder, preserving `RD = never` at the gateway.
   */
  readonly args?: Schema.Decoder<unknown> | undefined;
  /**
   * Erased declared error schema. Narrowed to `Schema.Top` (not just
   * `{ ast }`) so `errorSchema` / `dispatchResultSchema` can hand the live
   * schema to adapters without a boundary cast — any future op constructor
   * that lands a value in `error` must land a real Schema.
   */
  readonly error: Schema.Top | undefined;
  readonly resolve: (ctx: {
    readonly args: never;
    readonly selections: ReadonlySet<string>;
  }) => Stream.Stream<unknown, unknown, unknown>;
}

export interface OperationDefinition<
  Type,
  Args = undefined,
  E = never,
  R = never,
  Streamed extends boolean = boolean,
  ErrS extends Schema.Top = Schema.Top,
> {
  readonly _stream: Streamed;
  readonly type: Schema.Schema<Type>;
  readonly args?: Schema.Decoder<Args>;
  /**
   * Declared error schema — adapter metadata, never used by the walker.
   * `ErrS` carries the declared schema's exact type so adapters recover
   * precise wire typing; it is `never` when no schema was declared, which
   * `Domain.MissingErrorSchemas` uses for compile-time enforcement. The slot
   * is required (`| undefined`, not optional) so type-level extraction never
   * has to reason about property absence.
   */
  readonly error: ErrS | undefined;
  readonly resolve: (ctx: {
    readonly args: Args;
    readonly selections: ReadonlySet<string>;
  }) => Stream.Stream<Type, E, R>;
}

/**
 * Configuration for a single-value operation: the root `type`, an optional
 * `args` decoder, and an Effect-returning `resolve`.
 *
 * @since 0.1.0
 * @category models
 */
export interface OperationDef<Type, Args = undefined, E = never, R = never> {
  readonly type: Schema.Schema<Type>;
  readonly args?: Schema.Decoder<Args>;
  /**
   * Optional declared error schema describing the expected failures in `E`.
   * Pure adapter metadata: the walker and execute paths never touch it, but
   * adapters (GraphQL result unions, wire codecs) can read its AST via
   * `inspect()`. `operation()` checks at the type level that the schema's
   * `Type` covers the resolver's failure type `E`.
   */
  readonly error?: Schema.Top;
  readonly resolve: (ctx: {
    readonly args: Args;
    readonly selections: ReadonlySet<string>;
  }) => Effect.Effect<NoInfer<Type>, E, R>;
}

/**
 * Defines a single-value entry point into the graph. The operation name is
 * the record key passed to `Domain.make`, not a config field.
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
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */

// Overload 1: an `error` schema is declared — `E extends ErrS["Type"]`
// checks at compile time that the schema covers every resolver failure.
// Expressed as a type-parameter constraint (not a conditional intersection)
// so context-sensitive resolvers keep full inference inside `Domain.make`.
export function operation<
  Type,
  ErrS extends Schema.Top,
  E extends ErrS["Type"],
  Args = undefined,
  R = never,
>(
  config: OperationDef<Type, Args, E, R> & { readonly error: ErrS },
): OperationDefinition<Type, Args, E, R, false, ErrS>;
export function operation<Type, Args = undefined, E = never, R = never>(
  config: OperationDef<Type, Args, E, R> & { readonly error?: never },
): OperationDefinition<Type, Args, E, R, false, never>;
export function operation<Type, Args = undefined, E = never, R = never>(
  config: OperationDef<Type, Args, E, R>,
): OperationDefinition<Type, Args, E, R, false> {
  return {
    _stream: false,
    type: config.type,
    ...(config.args !== undefined ? { args: config.args } : {}),
    error: config.error,
    resolve: (ctx) => Stream.fromEffect(config.resolve(ctx)),
  };
}

/**
 * Configuration for a stream operation: like {@link OperationDef} but
 * `resolve` returns a Stream, walked per emitted item.
 *
 * @since 0.1.0
 * @category models
 */
export interface SubscriptionDef<Type, Args = undefined, E = never, R = never> {
  readonly type: Schema.Schema<Type>;
  readonly args?: Schema.Decoder<Args>;
  /** Optional declared error schema; see {@link OperationDef}. */
  readonly error?: Schema.Top;
  readonly resolve: (ctx: {
    readonly args: Args;
    readonly selections: ReadonlySet<string>;
  }) => Stream.Stream<NoInfer<Type>, E, R>;
}

/**
 * Defines a stream entry point into the graph. Each emitted item is walked
 * with the caller's selection; consume via `graph.subscribe` or
 * `graph.dispatchSubscription`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Domain, subscription } from "effect-domain"
 *
 * const g = Domain.make({
 *   onUserCreated: subscription({
 *     type: User,
 *     resolve: () => UserEvents.stream,
 *   }),
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
// Overloads mirror `operation` — see the coverage note there.
export function subscription<
  Type,
  ErrS extends Schema.Top,
  E extends ErrS["Type"],
  Args = undefined,
  R = never,
>(
  config: SubscriptionDef<Type, Args, E, R> & { readonly error: ErrS },
): OperationDefinition<Type, Args, E, R, true, ErrS>;
export function subscription<Type, Args = undefined, E = never, R = never>(
  config: SubscriptionDef<Type, Args, E, R> & { readonly error?: never },
): OperationDefinition<Type, Args, E, R, true, never>;
export function subscription<Type, Args = undefined, E = never, R = never>(
  config: SubscriptionDef<Type, Args, E, R>,
): OperationDefinition<Type, Args, E, R, true> {
  return {
    _stream: true,
    type: config.type,
    ...(config.args !== undefined ? { args: config.args } : {}),
    error: config.error,
    resolve: config.resolve,
  };
}
