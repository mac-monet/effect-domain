import { Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { unwrapSuspend, unwrapType } from "../src/schema/ast.ts";

describe("suspend unwrapping", () => {
  it("unwraps suspend chains to the concrete type-side AST", () => {
    const User = Schema.Struct({ id: Schema.String });
    const suspended = Schema.suspend(() => Schema.suspend(() => User));
    expect(SchemaAST.isObjects(unwrapType(suspended.ast))).toBe(true);
    expect(SchemaAST.isObjects(unwrapSuspend(SchemaAST.toType(suspended.ast)))).toBe(true);
  });

  it("throws (rather than looping) on a self-referential suspend cycle", () => {
    // A suspend whose thunk resolves back to itself never reaches a concrete
    // type. toType memoizes through Suspend.recur, so the recur'd suspend's
    // thunk returns itself — the guard must fire on the second iteration
    // instead of chasing fresh toType wrappers forever.
    const holder: { s?: Schema.Codec<unknown> } = {};
    holder.s = Schema.suspend(() => holder.s!);
    expect(() => unwrapType(holder.s!.ast)).toThrow(/Suspend cycle/);
    expect(() => unwrapSuspend(holder.s!.ast)).toThrow(/Suspend cycle/);
  });
});
