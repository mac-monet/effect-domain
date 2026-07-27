import { SchemaAST } from "effect";
import {
  arrayWrappedProjectableUnionTarget,
  isNullable,
  isNullishAst,
  MixedProjectableRoot,
  nonNullishRootAst,
  projectableRootDepths,
  projectableRootTarget,
  unwrapSuspend,
  unwrapType,
  wrapAstInArrays,
} from "../schema/ast.ts";

export type OpaqueRootReason =
  | "mixed object/scalar union root"
  | "mixed collection union root"
  | "scalar-only union root"
  | "null-or-scalar root";

/**
 * The single classification of an operation-root AST shared by the walker
 * (`walkRoot`), the response codec (`rootToResponseSchemaInternal`), and the
 * selection schema (`rootToSelectionSchemaInternal`). Each interpreter reads
 * structural facts from the plan instead of re-deriving them from the AST, so
 * the three can never disagree about what a root is.
 *
 * Plans are cached per AST identity and any synthesized ASTs (union targets,
 * unwrapped array-in-union elements) are built once during construction —
 * downstream WeakMap caches keyed on those ASTs stay stable across calls.
 */
export type RootPlan =
  | {
      readonly _tag: "ObjectRoot";
      readonly nullable: boolean;
      /**
       * AST for runtime traversal: the original (possibly nullish-including)
       * union is kept intact so `walkNode` can discriminate variants by
       * sentinel against the real members.
       */
      readonly walkTarget: SchemaAST.AST;
      /**
       * AST for schema derivation: the projection target with nullish members
       * stripped (a synthesized union when multiple object targets exist).
       */
      readonly schemaTarget: SchemaAST.AST;
    }
  | {
      readonly _tag: "ArrayRoot";
      readonly nullable: boolean;
      /** Raw element AST — `resolveValue` / element codecs recurse from here. */
      readonly element: SchemaAST.AST;
      /** Deep object target the root selection is written against. */
      readonly selectionTarget: SchemaAST.AST;
    }
  | {
      readonly _tag: "OpaqueRoot";
      readonly nullable: boolean;
      /**
       * The declared root is an array shape (opaque elements or an empty
       * tuple), so the walker still enforces the array-shape defect check.
       */
      readonly mustBeArray: boolean;
      /** Non-nullish AST for pass-through codec derivation. */
      readonly codecAst: SchemaAST.AST;
      readonly reason?: OpaqueRootReason;
    };

export type FieldSelectionProjection =
  | {
      readonly _tag: "Nested";
      readonly target: SchemaAST.AST;
    }
  | {
      readonly _tag: "Scalar";
    };

const rootPlanCache = new WeakMap<SchemaAST.AST, RootPlan>();

export function rootPlan(ast: SchemaAST.AST): RootPlan {
  const cached = rootPlanCache.get(ast);
  if (cached) return cached;
  const built = buildRootPlan(ast);
  rootPlanCache.set(ast, built);
  return built;
}

function buildRootPlan(ast: SchemaAST.AST): RootPlan {
  const typeAst = unwrapType(ast);
  const nullable = isNullable(typeAst);

  if (SchemaAST.isArrays(typeAst)) {
    const element = typeAst.rest[0];
    if (!element) return opaqueRoot(typeAst, false, true, undefined);
    if (hasMixedCollectionShape(element)) {
      return opaqueRoot(typeAst, false, true, "mixed collection union root");
    }
    const target = projectableRootTarget(typeAst);
    if (target && target !== MixedProjectableRoot) {
      return { _tag: "ArrayRoot", nullable: false, element, selectionTarget: target };
    }
    return opaqueRoot(typeAst, false, true, undefined);
  }

  if (SchemaAST.isObjects(typeAst)) {
    return { _tag: "ObjectRoot", nullable: false, walkTarget: typeAst, schemaTarget: typeAst };
  }

  if (SchemaAST.isUnion(typeAst)) {
    if (hasMixedCollectionShape(typeAst)) {
      return opaqueRoot(typeAst, nullable, false, "mixed collection union root");
    }
    const target = projectableRootTarget(typeAst);
    if (target === MixedProjectableRoot) {
      return opaqueRoot(typeAst, nullable, false, "mixed object/scalar union root");
    }
    if (target) {
      const wrapped = arrayWrappedProjectableUnionTarget(typeAst);
      if (wrapped) {
        return {
          _tag: "ArrayRoot",
          nullable,
          element: wrapAstInArrays(wrapped.target, wrapped.depth - 1),
          selectionTarget: wrapped.target,
        };
      }
      return { _tag: "ObjectRoot", nullable, walkTarget: typeAst, schemaTarget: target };
    }
    return opaqueRoot(
      typeAst,
      nullable,
      false,
      hasOpaqueUnionMember(typeAst) ? "scalar-only union root" : "null-or-scalar root",
    );
  }

  if (SchemaAST.isNull(typeAst) || SchemaAST.isUndefined(typeAst) || SchemaAST.isVoid(typeAst)) {
    return opaqueRoot(typeAst, nullable, false, "null-or-scalar root");
  }

  return opaqueRoot(typeAst, false, false, undefined);
}

function opaqueRoot(
  typeAst: SchemaAST.AST,
  nullable: boolean,
  mustBeArray: boolean,
  reason: OpaqueRootReason | undefined,
): RootPlan {
  return {
    _tag: "OpaqueRoot",
    nullable,
    mustBeArray,
    codecAst: nullable ? nonNullishRootAst(typeAst) : typeAst,
    ...(reason !== undefined && { reason }),
  };
}

function nestedSelectionTarget(ast: SchemaAST.AST): SchemaAST.AST | undefined {
  const typeAst = unwrapSuspend(ast);
  if (SchemaAST.isObjects(typeAst) || SchemaAST.isUnion(typeAst)) return typeAst;
  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    return inner ? nestedSelectionTarget(inner) : undefined;
  }
  return undefined;
}

export function fieldSelectionProjection(ast: SchemaAST.AST): FieldSelectionProjection {
  const target = nestedSelectionTarget(ast);
  return target ? { _tag: "Nested", target } : { _tag: "Scalar" };
}

function hasMixedCollectionShape(ast: SchemaAST.AST): boolean {
  return projectableRootDepths(ast).size > 1;
}

function hasOpaqueUnionMember(union: SchemaAST.Union): boolean {
  for (const member of union.types) {
    const memberType = unwrapType(member);
    if (isNullishAst(memberType)) continue;
    if (!projectableRootTarget(memberType)) return true;
  }
  return false;
}
