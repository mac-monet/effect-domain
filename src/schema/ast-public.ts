/**
 * The library's canonical SchemaAST reading helpers, re-exported for
 * adapters. Everything here operates on the type side via the canonicalizing
 * `unwrapType` memo — sharing it keeps adapter traversals convergent on
 * recursive schemas (see the memoization notes in `ast.ts`).
 *
 * @since 0.2.0
 */
export { identifierOf, isNullishAst, splitNullability, unwrapType } from "./ast.ts";
