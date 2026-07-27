import { Effect, Result, Schema, SchemaTransformation, Stream } from "effect";
import type { AnyOperationDef } from "./define.ts";
import type { Selection } from "./selection/index.ts";
import type { RootSelectionCodec } from "./selection/schema.ts";

/**
 * Wire schema for a name-less invocation payload (`{ args?, select? }`), for
 * transports that carry the operation name out-of-band (URL path, queue
 * routing key). Also exported as `Domain.DispatchPayload`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DispatchPayloadSchema = Schema.Struct({
  args: Schema.optional(Schema.Unknown),
  select: Schema.optional(Schema.Unknown),
});

/**
 * @since 0.1.0
 * @category models
 */
export type DispatchPayload = Schema.Schema.Type<typeof DispatchPayloadSchema>;

/**
 * Wire schema for a full invocation envelope (`{ name, args?, select? }`).
 * The envelope carries only client data — execution policy (walker
 * concurrency) is the server's to decide, so it lives in
 * {@link DispatchOptions} at the dispatch call site, never on the wire.
 * Unknown envelope keys (including a legacy `concurrency`) are stripped on
 * decode. Also exported as `Domain.DispatchRequest`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DispatchRequestSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Unknown),
  select: Schema.optional(Schema.Unknown),
});

/**
 * @since 0.1.0
 * @category models
 */
export type DispatchRequest = Schema.Schema.Type<typeof DispatchRequestSchema>;

/**
 * Server-side execution policy for `dispatch` / `dispatchSubscription` /
 * `prepared.execute` — deliberately separate from the wire envelope.
 *
 * @since 0.1.0
 * @category models
 */
export interface DispatchOptions {
  readonly concurrency?: number | "unbounded";
  /**
   * Collect the walk's read set. Successful dispatches then carry an
   * `Execution`-shaped envelope `{ result, reads }` as their success value.
   * Server-side policy, never part of the wire envelope.
   */
  readonly reads?: boolean;
}

/**
 * Decodes an untrusted `{ args?, select? }` payload.
 *
 * @since 0.1.0
 * @category decoding
 */
export function decodeDispatchPayload(input: unknown) {
  return Schema.decodeUnknownEffect(DispatchPayloadSchema)(input);
}

/**
 * Decodes an untrusted `{ name, args?, select? }` envelope.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { decodeDispatchRequest } from "effect-domain"
 *
 * const handle = (body: unknown) =>
 *   Effect.flatMap(decodeDispatchRequest(body), (request) => graph.dispatch(request))
 * ```
 *
 * @since 0.1.0
 * @category decoding
 */
export function decodeDispatchRequest(input: unknown) {
  return Schema.decodeUnknownEffect(DispatchRequestSchema)(input);
}

/**
 * Boundary error: the dispatched `name` is not an operation on the graph.
 * HTTP analogue: 4xx.
 *
 * @since 0.1.0
 * @category errors
 */
export class UnknownOperation extends Schema.TaggedErrorClass<UnknownOperation>()(
  "UnknownOperation",
  { operation: Schema.String },
) {}

/**
 * Boundary error: `args` failed to decode against the operation's args
 * schema. HTTP analogue: 4xx.
 *
 * @since 0.1.0
 * @category errors
 */
export class ArgsParseError extends Schema.TaggedErrorClass<ArgsParseError>()("ArgsParseError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/**
 * Boundary error: `select` failed to decode against the operation's
 * selection schema. HTTP analogue: 4xx.
 *
 * @since 0.1.0
 * @category errors
 */
export class SelectionParseError extends Schema.TaggedErrorClass<SelectionParseError>()(
  "SelectionParseError",
  { operation: Schema.String, cause: Schema.Unknown },
) {}

/**
 * Boundary error: a single-value operation was dispatched as a subscription
 * or vice versa. HTTP analogue: 4xx.
 *
 * @since 0.1.0
 * @category errors
 */
export class WrongOperationKind extends Schema.TaggedErrorClass<WrongOperationKind>()(
  "WrongOperationKind",
  {
    operation: Schema.String,
    expected: Schema.Union([Schema.Literal("operation"), Schema.Literal("subscription")]),
    actual: Schema.Union([Schema.Literal("operation"), Schema.Literal("subscription")]),
  },
) {}

const OperationErrorDeclare = <E>() =>
  Schema.declare<OperationError<E>>((u): u is OperationError<E> => u instanceof OperationError);

/**
 * Wraps an operation resolver's typed failure (`E`) when it flows through the
 * `dispatch` Result value channel. Generic over E so {@link Domain.orFail} can
 * infer the operation's E type at the call site; the static `schema` helper
 * makes transport round-trips decode back into live `OperationError`
 * instances while letting each adapter choose the cause schema. HTTP
 * analogue: 5xx by default.
 *
 * @since 0.1.0
 * @category errors
 */
export class OperationError<E = unknown> {
  readonly _tag = "OperationError" as const;
  constructor(
    readonly operation: string,
    readonly cause: E,
  ) {}

  /**
   * Returns a Schema that encodes/decodes the wire shape
   * `{ _tag: "OperationError", operation: string, cause: <C> }`.
   *
   * Decodes back to a live `OperationError` instance, so `instanceof
   * OperationError` and `Domain.orFail` semantics are preserved after crossing a
   * transport boundary.
   */
  static schema<C extends Schema.Top>(
    causeSchema: C,
  ): Schema.Codec<
    OperationError<C["Type"]>,
    {
      readonly _tag: "OperationError";
      readonly operation: string;
      readonly cause: C["Encoded"];
    },
    C["DecodingServices"],
    C["EncodingServices"]
  > {
    const Wire = Schema.TaggedStruct("OperationError", {
      operation: Schema.String,
      cause: causeSchema,
    });

    type DecodedWire = {
      readonly _tag: "OperationError";
      readonly operation: string;
      readonly cause: C["Type"];
    };

    const transformation = SchemaTransformation.transform<OperationError<C["Type"]>, DecodedWire>({
      decode: (wire) => new OperationError(wire.operation, wire.cause),
      encode: (error) => ({
        _tag: "OperationError",
        operation: error.operation,
        cause: error.cause,
      }),
    });

    return Wire.pipe(
      Schema.decodeTo(OperationErrorDeclare<C["Type"]>(), transformation as never),
    ) as never;
  }
}

/**
 * Union of the boundary errors `dispatch` can put in the Result value
 * channel. Operation failures are separate — see {@link OperationError}.
 *
 * @since 0.1.0
 * @category errors
 */
export type GatewayError =
  | UnknownOperation
  | ArgsParseError
  | SelectionParseError
  | WrongOperationKind;

/**
 * Schema for the {@link GatewayError} union, for transports serializing
 * boundary errors.
 *
 * @since 0.1.0
 * @category schemas
 */
export const GatewayError: Schema.Schema<GatewayError> = Schema.Union([
  UnknownOperation,
  ArgsParseError,
  SelectionParseError,
  WrongOperationKind,
]);

/**
 * Args schema for operations declared without an `args` field.
 *
 * Accepts `undefined` or an empty object `{}` and decodes both to `undefined`.
 * Anything else (including non-empty objects) fails with a parse error,
 * surfaced as `ArgsParseError` at the boundary — silently dropping unexpected
 * args is a footgun for transports that wire things up by mistake.
 */
export const emptyArgsSchema: Schema.Decoder<undefined> = Schema.Unknown.pipe(
  Schema.refine(
    (v): v is undefined | Record<string, never> =>
      v === undefined ||
      (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0),
    { message: "Operation accepts no args; expected undefined or {}." },
  ),
  Schema.decodeTo(
    Schema.Undefined,
    // Transform type bridge: both accepted inputs decode to the single
    // undefined args value; Effect Schema cannot infer that through Unknown.
    SchemaTransformation.transform({
      decode: (): undefined => undefined,
      encode: (): undefined => undefined,
    }) as never,
  ),
);

/**
 * Resolves an operation's args Decoder, falling back to {@link emptyArgsSchema}
 * for arg-less operations.
 *
 * Soundness: the user-facing `OperationDef.args` slot is constrained to
 * `Schema.Decoder<Args>` (RD = never by default) and the erased
 * `AnyOperationDef.args` mirrors that as `Schema.Decoder<unknown>`, so
 * `decodeUnknownEffect(argsSchemaFor(op))` produces `R = never` without a cast.
 */
export function argsSchemaFor(op: AnyOperationDef): Schema.Decoder<unknown> {
  return op.args ?? emptyArgsSchema;
}

export interface BoundaryDecoded {
  readonly op: AnyOperationDef;
  readonly args: unknown;
  readonly select?: Selection;
}

export function decodeBoundary(
  config: DispatchRequest,
  ops: Record<string, AnyOperationDef>,
  selectionSchemaFor: (name: string) => RootSelectionCodec,
  expectedKind?: "operation" | "subscription",
): Effect.Effect<BoundaryDecoded, GatewayError> {
  return Effect.suspend((): Effect.Effect<BoundaryDecoded, GatewayError> => {
    if (!Object.hasOwn(ops, config.name)) {
      return Effect.fail(new UnknownOperation({ operation: config.name }));
    }
    const op = ops[config.name]!;
    const actualKind = op._stream ? "subscription" : "operation";
    if (expectedKind !== undefined && actualKind !== expectedKind) {
      return Effect.fail(
        new WrongOperationKind({
          operation: config.name,
          expected: expectedKind,
          actual: actualKind,
        }),
      );
    }

    const decodedSelect: Effect.Effect<Selection | undefined, SelectionParseError> = Effect.flatMap(
      Effect.try({
        try: () => selectionSchemaFor(config.name),
        catch: (err) => new SelectionParseError({ operation: config.name, cause: err }),
      }),
      (selectionSchema) =>
        Effect.mapError(
          Schema.decodeUnknownEffect(selectionSchema)(config.select),
          (err) => new SelectionParseError({ operation: config.name, cause: err }),
        ),
    );

    const decodedArgs: Effect.Effect<unknown, ArgsParseError> = Effect.mapError(
      Schema.decodeUnknownEffect(argsSchemaFor(op))(config.args),
      (err) => new ArgsParseError({ operation: config.name, cause: err }),
    );

    return Effect.flatMap(decodedArgs, (args) =>
      Effect.map(decodedSelect, (select) => ({
        op,
        args,
        ...(select !== undefined ? { select } : {}),
      })),
    );
  });
}

export function liftBoundaryToResult<A, E, R>(
  inner: (decoded: BoundaryDecoded) => Effect.Effect<A, E, R>,
  decode: Effect.Effect<BoundaryDecoded, GatewayError>,
  operationName: string,
): Effect.Effect<Result.Result<A, GatewayError | OperationError<E>>, never, R> {
  return Effect.matchEffect(decode, {
    onFailure: (err) => Effect.succeed(Result.fail(err)),
    onSuccess: (decoded) =>
      Effect.map(
        Effect.result(inner(decoded)),
        (exec): Result.Result<A, GatewayError | OperationError<E>> =>
          Result.isFailure(exec)
            ? Result.fail(new OperationError(operationName, exec.failure))
            : Result.succeed(exec.success),
      ),
  });
}

export function liftBoundaryStreamToResult<A, E, R>(
  inner: (decoded: BoundaryDecoded) => Stream.Stream<A, E, R>,
  decode: Effect.Effect<BoundaryDecoded, GatewayError>,
  operationName: string,
): Stream.Stream<Result.Result<A, GatewayError | OperationError<E>>, never, R> {
  type Outcome = Result.Result<A, GatewayError | OperationError<E>>;
  return Stream.unwrap(
    Effect.match(decode, {
      onFailure: (err): Stream.Stream<Outcome, never, R> =>
        Stream.succeed<Outcome>(Result.fail(err)),
      onSuccess: (decoded): Stream.Stream<Outcome, never, R> =>
        Stream.map(
          Stream.result(inner(decoded)),
          (r): Outcome =>
            Result.isFailure(r)
              ? Result.fail(new OperationError(operationName, r.failure))
              : Result.succeed(r.success),
        ),
    }),
  );
}
