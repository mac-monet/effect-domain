import { Result, Schema, SchemaTransformation } from "effect";

const ResultDeclare = <A, E>() =>
  Schema.declare<Result.Result<A, E>>((u): u is Result.Result<A, E> => Result.isResult(u));

/**
 * The encoded dispatch-Result envelope: the shape `handleDispatch` /
 * `handleSubscription` produce and `ResultCodec` encodes to. Adapters that
 * unwrap the envelope by hand (instead of decoding with `ResultCodec`)
 * should type it with this instead of re-declaring the shape.
 *
 * @since 0.1.0
 * @category models
 */
export type WireShape<A, E> =
  | { readonly _tag: "Success"; readonly success: A }
  | { readonly _tag: "Failure"; readonly failure: E };

/**
 * A small Schema helper for `Result<S, F>`. Encodes to the tagged wire shape
 * `{ _tag: "Success", success: <S> } | { _tag: "Failure", failure: <F> }` and
 * decodes back to a live `Result` instance (so `Result.isSuccess` /
 * `Result.isFailure` work on the decoded value).
 *
 * Opt-in primitive for clients that want typed wire payloads without reaching
 * for the full `responseSchema` synth.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ResultCodec } from "effect-domain"
 *
 * const FieldResult = ResultCodec(Schema.String, Schema.Unknown)
 * Schema.decodeUnknownSync(FieldResult)({ _tag: "Success", success: "Alice" })
 * // → Result.succeed("Alice") — a live Result instance
 * ```
 *
 * @since 0.1.0
 * @category schemas
 */
export const ResultCodec = <S extends Schema.Top, F extends Schema.Top>(
  success: S,
  failure: F,
): Schema.Codec<
  Result.Result<S["Type"], F["Type"]>,
  WireShape<S["Encoded"], F["Encoded"]>,
  S["DecodingServices"] | F["DecodingServices"],
  S["EncodingServices"] | F["EncodingServices"]
> => {
  const Wire = Schema.Union([
    Schema.TaggedStruct("Success", { success }),
    Schema.TaggedStruct("Failure", { failure }),
  ]);

  type DecodedWire = WireShape<S["Type"], F["Type"]>;

  // Cast: TaggedStruct's Type_ doesn't structurally simplify to DecodedWire while
  // S/F are still generic, so we tell decodeTo to take the transform as-is.
  const transformation = SchemaTransformation.transform<
    Result.Result<S["Type"], F["Type"]>,
    DecodedWire
  >({
    decode: (wire) =>
      wire._tag === "Success" ? Result.succeed(wire.success) : Result.fail(wire.failure),
    encode: (value) =>
      Result.isSuccess(value)
        ? { _tag: "Success", success: value.success }
        : { _tag: "Failure", failure: value.failure },
  });

  return Wire.pipe(
    Schema.decodeTo(ResultDeclare<S["Type"], F["Type"]>(), transformation as never),
  ) as never;
};
