import { Schema, SchemaAST } from "effect";

/**
 * A codec synthesized from runtime schema information whose exact static
 * Type/Encoded shape is not knowable at the construction site.
 *
 * Keep this type inside runtime schema synthesis modules; public API types
 * should expose semantic aliases or precise generics instead.
 */
export type DynamicCodec = Schema.Codec<unknown, unknown, never, never>;

export const unknownCodec: DynamicCodec = Schema.Unknown as DynamicCodec;

// These helpers are the named widening boundary for runtime-built schemas.
// Callers should compose DynamicCodec values instead of writing inline casts.
export function codecFromAst(ast: SchemaAST.AST): DynamicCodec {
  return Schema.make(SchemaAST.toType(ast)) as unknown as DynamicCodec;
}

export function arrayCodec(item: DynamicCodec): DynamicCodec {
  return Schema.Array(item) as unknown as DynamicCodec;
}

export function structCodec(fields: Record<string, DynamicCodec>): DynamicCodec {
  return Schema.Struct(fields as never) as unknown as DynamicCodec;
}

export function unionCodec(codecs: ReadonlyArray<DynamicCodec>): DynamicCodec {
  if (codecs.length === 0) return unknownCodec;
  if (codecs.length === 1) return codecs[0]!;
  return Schema.Union(codecs as never) as unknown as DynamicCodec;
}

export function optionalCodec(codec: DynamicCodec): DynamicCodec {
  return Schema.optional(codec) as unknown as DynamicCodec;
}

export function suspendCodec(thunk: () => DynamicCodec): DynamicCodec {
  return Schema.suspend(thunk) as unknown as DynamicCodec;
}

export function unsafeCoerceCodec(codec: Schema.Top): DynamicCodec {
  return codec as unknown as DynamicCodec;
}
