import type { Effect, Option, Result, Stream } from "effect";
import type { AnyOperationDef, OperationDefinition } from "../define.ts";
import type { HasArrayMember, RootSelectionFor, UnionKeys } from "../selection/syntax.ts";
import type { ReadSet } from "../walk.ts";

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

export type AllE<Ops extends Record<string, AnyOperationDef>> = {
  [K in keyof Ops]: ExtractE<Ops[K]>;
}[keyof Ops];
export type AllR<Ops extends Record<string, AnyOperationDef>> = {
  [K in keyof Ops]: ExtractR<Ops[K]>;
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
      Exclude<ExtractR<Op>, Provided> | ProvidedR
    >
  : (
      args: ExtractArgs<Op>,
    ) => Effect.Effect<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<ExtractR<Op>, Provided> | ProvidedR
    >;

type BindSubscriptionMethod<Op, S, Provided, ProvidedE, ProvidedR> = [ExtractArgs<Op>] extends [
  undefined,
]
  ? () => Stream.Stream<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<ExtractR<Op>, Provided> | ProvidedR
    >
  : (
      args: ExtractArgs<Op>,
    ) => Stream.Stream<
      DomainRootResultOf<ExtractType<Op>, S>,
      ExtractE<Op> | ProvidedE,
      Exclude<ExtractR<Op>, Provided> | ProvidedR
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
 * @since 0.2.0
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
