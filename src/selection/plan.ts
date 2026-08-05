import { Schema, SchemaAST } from "effect";
import type { StoredFieldDef } from "../define.ts";
import type { NodeRegistry } from "../registry.ts";
import { unwrapType } from "../schema/ast.ts";
import { type ParsedFieldEntry, parseSelection, type Selection, selectionKeys } from "./syntax.ts";

export interface SelectedFieldPlan<R = never> {
  readonly entry: ParsedFieldEntry;
  readonly fieldAsts: ReadonlyArray<SchemaAST.AST>;
  /** Immediate child field names of `entry.select`, for resolver lookahead. */
  readonly childSelections: ReadonlySet<string>;
  readonly fieldDef?: StoredFieldDef<R>;
}

export interface SelectedNodePlan<R = never> {
  readonly ast: SchemaAST.AST;
  readonly fields: ReadonlyArray<SelectedFieldPlan<R>>;
}

export type RuntimeFieldPlan<R = never> =
  | ({
      readonly _tag: "Resolve";
    } & SelectedFieldPlan<R>)
  | {
      readonly _tag: "MissingOnVariant";
      readonly entry: ParsedFieldEntry;
    };

export interface RuntimeNodePlan<R = never> {
  readonly unionAst: SchemaAST.Union;
  readonly memberAst: SchemaAST.AST;
  readonly fields: ReadonlyArray<RuntimeFieldPlan<R>>;
}

// Plans depend only on the AST and the selection object, both stable within a
// call (and usually across calls), while the walker requests a plan for every
// object instance at every depth — a 10k-element array would otherwise
// re-parse the same selection 10k times. Keyed by object identity: a changed
// selection is a different object, and entries are GC'd with their keys.
const selectedPlanCache = new WeakMap<SchemaAST.AST, WeakMap<Selection, SelectedNodePlan>>();

const runtimePlanCache = new WeakMap<
  SchemaAST.Union,
  WeakMap<SchemaAST.AST, WeakMap<Selection, RuntimeNodePlan>>
>();

// R is a phantom on the stored field defs' resolve signatures (an erased
// contravariant channel); plans are computed identically for every R, so one
// cached plan serves all instantiations.
function withPlanTypeParameter<R>(plan: SelectedNodePlan): SelectedNodePlan<R> {
  return plan as SelectedNodePlan<R>;
}

function withRuntimePlanTypeParameter<R>(plan: RuntimeNodePlan): RuntimeNodePlan<R> {
  return plan as RuntimeNodePlan<R>;
}

export function planSelectedNode<R = never>(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection,
): SelectedNodePlan<R> {
  let bySelection = selectedPlanCache.get(ast);
  if (!bySelection) {
    bySelection = new WeakMap();
    selectedPlanCache.set(ast, bySelection);
  }
  const cached = bySelection.get(selection);
  if (cached) return withPlanTypeParameter<R>(cached);

  const built: SelectedNodePlan = {
    ast,
    fields: planSelectedFields(registry, ast, selection),
  };
  bySelection.set(selection, built);
  return withPlanTypeParameter<R>(built);
}

const EMPTY_SELECTIONS: ReadonlySet<string> = new Set();

export function planSelectedFields<R = never>(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection,
): ReadonlyArray<SelectedFieldPlan<R>> {
  return parseSelection(selection).map((entry) => ({
    entry,
    childSelections: entry.select ? selectionKeys(entry.select) : EMPTY_SELECTIONS,
    ...lookupSelectedField<R>(registry, ast, entry.fieldName),
  }));
}

export function planRuntimeNode<R = never>(
  registry: NodeRegistry,
  unionAst: SchemaAST.Union,
  memberAst: SchemaAST.AST,
  selection: Selection,
): RuntimeNodePlan<R> {
  let byMember = runtimePlanCache.get(unionAst);
  if (!byMember) {
    byMember = new WeakMap();
    runtimePlanCache.set(unionAst, byMember);
  }
  let bySelection = byMember.get(memberAst);
  if (!bySelection) {
    bySelection = new WeakMap();
    byMember.set(memberAst, bySelection);
  }
  const cached = bySelection.get(selection);
  if (cached) return withRuntimePlanTypeParameter<R>(cached);

  const built: RuntimeNodePlan = {
    unionAst,
    memberAst,
    fields: planRuntimeFields(registry, unionAst, memberAst, selection),
  };
  bySelection.set(selection, built);
  return withRuntimePlanTypeParameter<R>(built);
}

export function planRuntimeFields<R = never>(
  registry: NodeRegistry,
  unionAst: SchemaAST.Union,
  memberAst: SchemaAST.AST,
  selection: Selection,
): ReadonlyArray<RuntimeFieldPlan<R>> {
  const unionPlans = planSelectedFields<R>(registry, unionAst, selection);
  const memberPlans = planSelectedFields<R>(registry, memberAst, selection);
  const memberByOutputKey = new Map(
    memberPlans.map((field) => [field.entry.outputKey, field] as const),
  );

  return unionPlans.map((unionPlan) => {
    const memberPlan = memberByOutputKey.get(unionPlan.entry.outputKey);
    if (memberPlan && memberPlan.fieldAsts.length > 0) {
      // memberPlan's childSelections stays valid under unionPlan.entry: both
      // plans parse the same selection object, so the entries share `select`.
      return { _tag: "Resolve", ...memberPlan, entry: unionPlan.entry };
    }
    if (unionPlan.fieldAsts.length > 0) {
      return { _tag: "MissingOnVariant", entry: unionPlan.entry };
    }
    return { _tag: "Resolve", ...unionPlan };
  });
}

function lookupSelectedField<R>(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  fieldName: string,
): Pick<SelectedFieldPlan<R>, "fieldAsts" | "fieldDef"> {
  const typeAst = unwrapType(ast);

  if (SchemaAST.isUnion(typeAst)) {
    const memberPlans = typeAst.types.map((member) =>
      lookupSelectedField<R>(registry, member, fieldName),
    );
    const matchedPlans = memberPlans.filter((plan) => plan.fieldAsts.length > 0);
    const fieldAsts = matchedPlans.flatMap((plan) => plan.fieldAsts);
    if (fieldAsts.length === 0) return { fieldAsts };
    if (matchedPlans.length !== memberPlans.length) {
      return { fieldAsts: [...fieldAsts, Schema.Undefined.ast] };
    }
    return { fieldAsts };
  }

  if (!SchemaAST.isObjects(typeAst)) return { fieldAsts: [] };

  const fieldDefs = registry.fieldDefsFor(typeAst) as Record<string, StoredFieldDef<R>> | undefined;
  const fieldDef = fieldDefs?.[fieldName];
  if (fieldDef) return { fieldAsts: [fieldDef.type.ast], fieldDef };

  for (const ps of typeAst.propertySignatures) {
    if (ps.name === fieldName) {
      // An optional key admits absence (`obj[fieldName]` is `undefined`);
      // surface that as an Undefined member so the response codec makes the
      // wire slot an optional key instead of a required one.
      return SchemaAST.isOptional(ps.type)
        ? { fieldAsts: [ps.type, Schema.Undefined.ast] }
        : { fieldAsts: [ps.type] };
    }
  }
  return { fieldAsts: [] };
}
