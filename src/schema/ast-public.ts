/**
 * The library's canonical SchemaAST reading helpers, re-exported for
 * adapters. Everything here operates on the raw AST via `unwrapSuspend` —
 * in Effect v4's type-primary model, the raw AST already carries type-side
 * structure, so no `toType` roundtrip is needed. Raw ASTs have stable
 * object identity, which keeps adapter traversals convergent on recursive
 * schemas by construction.
 *
 * @since 0.1.0
 */
export { identifierOf, isNullishAst, splitNullability, unwrapSuspend } from "./ast.ts";
