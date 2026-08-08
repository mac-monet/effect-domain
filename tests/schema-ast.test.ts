import { Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { unwrapSuspend } from "../src/schema/ast.ts";

describe("suspend unwrapping", () => {
  it("unwraps suspend chains to the concrete raw AST", () => {
    const User = Schema.Struct({ id: Schema.String });
    const suspended = Schema.suspend(() => Schema.suspend(() => User));
    expect(SchemaAST.isObjects(unwrapSuspend(suspended.ast))).toBe(true);
  });

  it("throws (rather than looping) on a self-referential suspend cycle", () => {
    // A suspend whose thunk resolves back to itself never reaches a concrete
    // type. The cycle guard must fire on the second iteration instead of
    // chasing the chain forever.
    const holder: { s?: Schema.Codec<unknown> } = {};
    holder.s = Schema.suspend(() => holder.s!);
    expect(() => unwrapSuspend(holder.s!.ast)).toThrow(/Suspend cycle/);
  });

  it("unwrapping a non-suspend AST is identity", () => {
    const User = Schema.Struct({ id: Schema.String });
    expect(unwrapSuspend(User.ast)).toBe(User.ast);
  });

  it("raw AST has stable identity through recursive suspends", () => {
    // The raw-primary invariant: Schema.suspend(() => X).ast.thunk() returns
    // the same X.ast reference every call, so identity-keyed caches converge
    // by construction without a fixpoint memo.
    interface CategoryShape {
      readonly name: string;
      readonly children: ReadonlyArray<CategoryShape>;
    }
    const Category: Schema.Schema<CategoryShape> = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Schema<CategoryShape> => Category)),
    });
    const catAst = Category.ast as SchemaAST.Objects;
    const innerSuspend = catAst.propertySignatures[1]!.type;
    const arrayAst = unwrapSuspend(innerSuspend);
    expect(SchemaAST.isArrays(arrayAst)).toBe(true);
    if (SchemaAST.isArrays(arrayAst)) {
      const elementSuspend = arrayAst.rest[0]!;
      expect(unwrapSuspend(elementSuspend)).toBe(Category.ast);
    }
  });

  it("throws (rather than looping) when a thunk mints a fresh Suspend per call", () => {
    // An identity-keyed cycle guard can never fire on this shape — every
    // iteration sees a brand-new Suspend node. The depth bound must catch it.
    const fresh = (): Schema.Codec<unknown> => Schema.suspend(() => fresh());
    expect(() => unwrapSuspend(fresh().ast)).toThrow(/suspend chain exceeded/);
  });
});
