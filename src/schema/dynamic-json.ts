import { Schema, SchemaAST } from "effect";

/** A runtime-built schema whose encoded side is canonical JSON. */
export type DynamicJsonCodec = Schema.Codec<unknown, Schema.Json, never, never>;

/** Canonicalizes a user or Effect schema as it enters dynamic synthesis. */
export function jsonCodec(schema: Schema.Top): DynamicJsonCodec {
  return Schema.toCodecJson(schema) as unknown as DynamicJsonCodec;
}

/** Rebuilds validation for resolver Type values, then derives their JSON codec. */
export function jsonCodecFromTypeAst(ast: SchemaAST.AST): DynamicJsonCodec {
  return jsonCodec(Schema.make(SchemaAST.toType(ast)));
}

export const jsonUnknownCodec = jsonCodec(Schema.Unknown);

// Containers preserve the JSON invariant because every child already has a
// JSON encoded side. Keep the unavoidable schema-invariance casts here.
export function arrayCodec(item: DynamicJsonCodec): DynamicJsonCodec {
  return Schema.Array(item) as unknown as DynamicJsonCodec;
}

export function structCodec(fields: Record<string, DynamicJsonCodec>): DynamicJsonCodec {
  return Schema.Struct(fields as never) as unknown as DynamicJsonCodec;
}

export function unionCodec(codecs: ReadonlyArray<DynamicJsonCodec>): DynamicJsonCodec {
  if (codecs.length === 0) return jsonUnknownCodec;
  if (codecs.length === 1) return codecs[0]!;
  return Schema.Union(codecs as never) as unknown as DynamicJsonCodec;
}

export function optionalCodec(codec: DynamicJsonCodec): DynamicJsonCodec {
  return Schema.optional(codec) as unknown as DynamicJsonCodec;
}

export function suspendCodec(thunk: () => DynamicJsonCodec): DynamicJsonCodec {
  return Schema.suspend(thunk) as unknown as DynamicJsonCodec;
}

/** Asserts JSON safety for a composition whose encoder emits only JSON codecs. */
export function unsafeJsonCodec(codec: Schema.Top): DynamicJsonCodec {
  return codec as unknown as DynamicJsonCodec;
}
