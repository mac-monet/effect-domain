import type { Effect, Option, Result, Schema, Stream } from "effect";
import type { AnyOperationDef, NodeMeta, OperationDefinition } from "../define.ts";
import type { HasArrayMember, RootSelectionFor, UnionKeys } from "../selection/syntax.ts";
import type { ReadSet } from "../walk.ts";

/**
 * The exact declared error schema type of an operation (`operation({ error })`),
 * or `never` when none was declared.
 */
export type ExtractErrorSchema<Op> = Op extends { readonly error: infer ErrS }
  ? ErrS extends Schema.Top
    ? ErrS
    : never
  : never;

/**
 * The wire-level error type for an operation: the declared error schema's
 * `Type` when one exists, else `never` — matching the runtime, which builds
 * undeclared error codecs from `Schema.Never`. An op that can fail but
 * declares no schema therefore types (and is) unable to round-trip its
 * failures; `MissingErrorSchemas` is the enforcement point for that.
 */
export type DeclaredErrorType<Op> = [ExtractErrorSchema<Op>] extends [never]
  ? never
  : ExtractErrorSchema<Op> extends { readonly Type: infer ErrT }
    ? ErrT
    : never;

/**
 * The operation names whose resolvers can fail (`E` is not `never`) but that
 * declared no `error` schema — the ops whose failures cannot round-trip a
 * wire. Adapters constrain on `[MissingErrorSchemas<Ops>] extends [never]`
 * to turn a missing declaration into a compile error at the adapter boundary.
 *
 * Only meaningful for concrete op records: erased `AnyOperationDef` records
 * (e.g. after `Domain.erase`) infer `E = never`, so the constraint is
 * vacuously satisfied — enforce before erasing.
 */
export type MissingErrorSchemas<Ops> = {
  [K in keyof Ops]: [ExtractE<Ops[K]>] extends [never]
    ? never
    : [ExtractErrorSchema<Ops[K]>] extends [never]
      ? K
      : never;
}[keyof Ops];

/**
 * Constraint for entry points that serialize failures — the wire handlers
 * (`handleDispatch`/`handleSubscription` via their `this` parameter) and
 * `Domain.wireClient`: satisfied only when every fallible operation declared
 * an `error` schema, otherwise the offending operation names surface in the
 * compile error. Applied at serialization boundaries, never at
 * `Domain.make` — domains used purely in-process shouldn't pay for schemas
 * they don't need.
 */
export type RequireErrorSchemas<Ops> = [MissingErrorSchemas<Ops>] extends [never]
  ? unknown
  : {
      readonly "operations missing a declared error schema": MissingErrorSchemas<Ops>;
    };

export type ExtractE<Op> =
  Op extends OperationDefinition<infer _T, infer _A, infer E, infer _R> ? E : never;
export type ExtractR<Op> =
  Op extends OperationDefinition<infer _T, infer _A, infer _E, infer R> ? R : never;
export type ExtractArgs<Op> =
  Op extends OperationDefinition<infer _T, infer A, infer _E, infer _R> ? A : unknown;
export type ExtractType<Op> =
  Op extends OperationDefinition<infer T, infer _A, infer _E, infer _R> ? T : unknown;
type ExtractStreamed<Op> =
  Op extends OperationDefinition<infer _T, infer _A, infer _E, infer _R, infer Streamed>
    ? Streamed
    : boolean;

// A hand-typed FieldDef (or erased record) can leave the phantom at its
// `unknown` default; treat that as "declares nothing" rather than poisoning
// the union.
type KnownOrNever<X> = unknown extends X ? never : X;
type FieldE<F> = F extends { readonly _error?: () => infer E } ? KnownOrNever<E> : never;
type FieldR<F> = F extends { readonly _requirements?: () => infer R } ? KnownOrNever<R> : never;
type UnwrapElement<T> = [NonNullable<T>] extends [readonly (infer E)[]]
  ? NonNullable<E>
  : NonNullable<T>;

type NodeFieldDefs<T> = T extends object
  ? T extends { readonly [NodeMeta]?: infer M }
    ? M extends { readonly fields: infer C }
      ? C
      : never
    : never
  : never;

/**
 * The requirement union of every computed field reachable from a node type:
 * its own fields plus, recursively, the fields of node-typed values under any
 * key (data or computed, through arrays and nullables). This is what `node()`
 * erases from the value surface and the {@link NodeMeta} phantom preserves.
 */
export type NodeR<T> = [NodeFieldDefs<T>] extends [never]
  ? never
  :
      | { [K in keyof NodeFieldDefs<T>]: FieldR<NodeFieldDefs<T>[K]> }[keyof NodeFieldDefs<T>]
      | { [K in keyof T & string]: NodeR<UnwrapElement<T[K]>> }[keyof T & string];

/** Selection-independent field error union, mirror of {@link NodeR}. Not yet
 * part of any signature: the walker does not fail operations on field errors
 * today, so surfacing this in `E` would claim failures that cannot happen.
 * The plain-data walker rework wires it in. */
export type NodeE<T> = [NodeFieldDefs<T>] extends [never]
  ? never
  :
      | { [K in keyof NodeFieldDefs<T>]: FieldE<NodeFieldDefs<T>[K]> }[keyof NodeFieldDefs<T>]
      | { [K in keyof T & string]: NodeE<UnwrapElement<T[K]>> }[keyof T & string];

/**
 * The full requirement type of an operation: the resolver's `R` plus the
 * requirements of every computed field reachable from its root type — the
 * walker runs those resolvers, so their services are needed at execute time.
 */
export type OperationR<Op> = ExtractR<Op> | NodeR<UnwrapElement<ExtractType<Op>>>;

export type AllE<Ops extends Record<string, AnyOperationDef>> = {
  [K in keyof Ops]: ExtractE<Ops[K]>;
}[keyof Ops];
export type AllR<Ops extends Record<string, AnyOperationDef>> = {
  [K in keyof Ops]: OperationR<Ops[K]>;
}[keyof Ops];

type OperationName<Ops extends Record<string, AnyOperationDef>> = Extract<keyof Ops, string>;
export type OperationNamesByStream<
  Ops extends Record<string, AnyOperationDef>,
  Streamed extends boolean,
> = {
  [K in OperationName<Ops>]: ExtractStreamed<Ops[K]> extends Streamed ? K : never;
}[OperationName<Ops>];

type BindConfigEntry<
  Ops extends Record<string, AnyOperationDef>,
  OpName extends OperationName<Ops>,
  Streamed extends boolean,
  S,
> = {
  readonly to?: OpName;
} & (OpName extends OperationNamesByStream<Ops, Streamed>
  ? [RootSelectionFor<ExtractType<Ops[OpName]>>] extends [never]
    ? { readonly select?: undefined }
    : { readonly select: S & RootSelectionFor<ExtractType<Ops[OpName]>> }
  : never);

type BindOperationName<
  Ops extends Record<string, AnyOperationDef>,
  MethodName extends string,
  Entry,
  Streamed extends boolean,
> = "to" extends keyof Entry
  ? NonNullable<Entry["to"]> extends OperationNamesByStream<Ops, Streamed>
    ? NonNullable<Entry["to"]>
    : never
  : Extract<MethodName, OperationNamesByStream<Ops, Streamed>>;

type BindSelection<Entry> = "select" extends keyof Entry
  ? Entry extends { readonly select?: infer S }
    ? S
    : undefined
  : undefined;

export type ValidateBindConfig<
  Ops extends Record<string, AnyOperationDef>,
  Config extends Readonly<Record<string, unknown>>,
  Streamed extends boolean,
> = {
  readonly [MethodName in keyof Config]: MethodName extends string
    ? BindOperationName<Ops, MethodName, Config[MethodName], Streamed> extends infer OpName
      ? OpName extends OperationName<Ops>
        ? BindConfigEntry<Ops, OpName, Streamed, BindSelection<Config[MethodName]>>
        : never
      : never
    : never;
};

type BindMethod<Op, S, Provided, ProvidedE, ProvidedR> = [ExtractArgs<Op>] extends [undefined]
  ? () => Effect.Effect<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<OperationR<Op>, Provided> | ProvidedR
    >
  : (
      args: ExtractArgs<Op>,
    ) => Effect.Effect<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<OperationR<Op>, Provided> | ProvidedR
    >;

type BindSubscriptionMethod<Op, S, Provided, ProvidedE, ProvidedR> = [ExtractArgs<Op>] extends [
  undefined,
]
  ? () => Stream.Stream<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<OperationR<Op>, Provided> | ProvidedR
    >
  : (
      args: ExtractArgs<Op>,
    ) => Stream.Stream<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<OperationR<Op>, Provided> | ProvidedR
    >;

export type BoundOperations<
  Ops extends Record<string, AnyOperationDef>,
  Config extends Readonly<Record<string, unknown>>,
  Provided,
  ProvidedE,
  ProvidedR,
> = {
  readonly [MethodName in keyof Config]: MethodName extends string
    ? BindOperationName<Ops, MethodName, Config[MethodName], false> extends infer OpName
      ? OpName extends OperationName<Ops>
        ? BindMethod<Ops[OpName], BindSelection<Config[MethodName]>, Provided, ProvidedE, ProvidedR>
        : never
      : never
    : never;
};

export type BoundSubscriptions<
  Ops extends Record<string, AnyOperationDef>,
  Config extends Readonly<Record<string, unknown>>,
  Provided,
  ProvidedE,
  ProvidedR,
> = {
  readonly [MethodName in keyof Config]: MethodName extends string
    ? BindOperationName<Ops, MethodName, Config[MethodName], true> extends infer OpName
      ? OpName extends OperationName<Ops>
        ? BindSubscriptionMethod<
            Ops[OpName],
            BindSelection<Config[MethodName]>,
            Provided,
            ProvidedE,
            ProvidedR
          >
        : never
      : never
    : never;
};

type ArgsConfig<Args> = [Args] extends [undefined]
  ? { readonly args?: Args }
  : { readonly args: Args };

type SelectionConfig<T, S> = [RootSelectionFor<T>] extends [never]
  ? { readonly select?: undefined }
  : { readonly select: S };

/**
 * Wire-invocation config: `args` and `select` only. Structurally the
 * remote subset of {@link DomainExecuteConfig} (no `reads`/`concurrency` —
 * both are server-side execution policy, never on the wire), but defined
 * directly rather than via `Omit`: mapped types block `const S` inference
 * at call sites, which silently degrades nested selection result types.
 */
export type DomainInvokeConfig<T, Args, S> = ArgsConfig<Args> & SelectionConfig<T, S>;

export type DomainExecuteConfig<T, Args, S> = ArgsConfig<Args> &
  SelectionConfig<T, S> & {
    readonly concurrency?: number | "unbounded";
    /**
     * Collect the walk's read set. With `reads: true`, `execute` returns an
     * {@link Execution} envelope `{ result, reads }` instead of the bare
     * result.
     */
    readonly reads?: boolean;
  };

/**
 * The envelope returned by `execute(name, { ..., reads: true })`: the
 * operation result plus per-execution artifacts. Extensible — future
 * instrumentation channels (costs, timings) land here as optional fields.
 *
 * @since 0.1.0
 * @category models
 */
export interface Execution<A> {
  readonly result: A;
  readonly reads: ReadSet;
}

type NullishOf<T> = Extract<T, null | undefined>;
type HasNullish<T> = [NullishOf<T>] extends [never] ? false : true;
type NonNullish<T> = Exclude<T, null | undefined>;
type ResultFieldValue<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? Exclude<T[K], undefined>
    : undefined
  : never;

type SelectionResult<T, Sel> = Sel extends { readonly select: infer Sub }
  ? HasNullish<T> extends true
    ? [NonNullish<T>] extends [readonly (infer E)[]]
      ? Result.Result<Option.None<never> | Array<RootElementResult<E, Sub>>, unknown>
      : Result.Result<Option.None<never> | DomainResultOf<NonNullish<T>, Sub>, unknown>
    : [NonNullable<T>] extends [readonly (infer E)[]]
      ? Result.Result<Array<RootElementResult<E, Sub>>, unknown>
      : Result.Result<DomainResultOf<NonNullish<T>, Sub>, unknown>
  : Result.Result<T, unknown>;

type NarrowField<T, Sel> = Sel extends { readonly select: infer Sub }
  ? [NonNullable<T>] extends [readonly (infer E)[]]
    ? Array<DomainNarrowBySelection<E, Sub>>
    : DomainNarrowBySelection<NonNullable<T>, Sub>
  : T;

type WrapResult<T> = [NonNullable<T>] extends [readonly (infer E)[]]
  ? [E] extends [Record<string, any>]
    ? Result.Result<Array<DomainResultTree<E>>, unknown>
    : Result.Result<Array<E>, unknown>
  : [NonNullable<T>] extends [Record<string, any>]
    ? Result.Result<DomainResultTree<NonNullable<T>>, unknown>
    : Result.Result<T, unknown>;

export type DomainResultOf<T, S> = {
  -readonly [K in keyof S & UnionKeys<T>]-?: SelectionResult<ResultFieldValue<T, K>, S[K]>;
};

type RootElementResult<E, S> =
  HasNullish<E> extends true
    ? Option.None<never> | DomainRootResultOf<NonNullish<E>, S>
    : DomainRootResultOf<E, S>;

export type DomainRootResultOf<T, S> =
  HasNullish<T> extends true
    ? Option.None<never> | DomainRootResultOf<NonNullish<T>, S>
    : [NonNullish<T>] extends [readonly (infer E)[]]
      ? [NonNullish<E>] extends [Record<string, any>]
        ? Array<RootElementResult<E, S>>
        : T
      : HasArrayMember<T> extends true
        ? T
        : [NonNullish<T>] extends [Record<string, any>]
          ? DomainResultOf<NonNullish<T>, S>
          : T;

export type DomainNarrowBySelection<T, S> = {
  -readonly [K in keyof S & keyof T]-?: NarrowField<Exclude<T[K], undefined>, S[K]>;
};

export type DomainResultTree<T> = {
  -readonly [K in keyof T]-?: WrapResult<Exclude<T[K], undefined>>;
};

export type ExecuteConfig<T, Args, S> = DomainExecuteConfig<T, Args, S>;
export type ResultOf<T, S> = DomainResultOf<T, S>;
export type RootResultOf<T, S> = DomainRootResultOf<T, S>;
export type NarrowBySelection<T, S> = DomainNarrowBySelection<T, S>;
export type ResultTree<T> = DomainResultTree<T>;
