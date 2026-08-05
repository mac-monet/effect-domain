import { Schema, SchemaAST } from "effect";
import {
  arrayCodec,
  codecFromAst,
  type DynamicCodec,
  structCodec,
  suspendCodec,
  unionCodec,
  unsafeCoerceCodec,
  unknownCodec,
} from "../schema/codec.ts";
import { canonicalizeSelection } from "../invocation-key.ts";
import type { NodeRegistry } from "../registry.ts";
import type { RootPlan } from "../selection/projection.ts";
import { isNullable, nonNullishRootAst, unwrapType } from "../schema/ast.ts";
import {
  planSelectedNode,
  type SelectedFieldPlan,
  type SelectedNodePlan,
} from "../selection/plan.ts";
import {
  DuplicateOutputKey,
  type Selection,
  UndefinedSelectionEntry,
} from "../selection/syntax.ts";

// Response codecs derive purely from AST identity plus the canonicalized
// selection, so caches are module-global WeakMaps shared across graphs and
// GC'd with their ASTs. The inner per-AST map is keyed by canonical selection
// JSON and unbounded — adapters synthesizing schemas for user-controlled
// selections own that lifecycle (see responseSchema docs).
const nodeResponseCache = new WeakMap<SchemaAST.AST, Map<string, DynamicCodec>>();
const rootResponseCache = new WeakMap<SchemaAST.AST, Map<string, DynamicCodec>>();

export function rootToResponseSchema(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection | undefined,
): DynamicCodec {
  // Validate before the cache: `{}` and `undefined` canonicalize to the same
  // cache key (they build the same codec on projectable roots), but only
  // `undefined` is legal on opaque roots — a cached opaque-root codec must
  // not mask the rejection of a concrete selection.
  if (selection !== undefined) {
    const plan = registry.rootPlanFor(ast);
    if (plan._tag === "OpaqueRoot") {
      throw opaqueRootSelectionError(plan.reason);
    }
  }
  const selectionKey = cacheKey(selection);
  const cached = getCached(rootResponseCache, ast, selectionKey);
  if (cached) return cached;
  const built = rootToResponseSchemaInternal(registry, ast, selection);
  setCached(rootResponseCache, ast, selectionKey, built);
  return built;
}

function rootToResponseSchemaInternal(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection | undefined,
): DynamicCodec {
  const plan = registry.rootPlanFor(ast);

  if (selection !== undefined && plan._tag === "OpaqueRoot") {
    throw opaqueRootSelectionError(plan.reason);
  }

  const base = rootBaseResponseSchema(registry, plan, selection);
  return plan.nullable ? noneOrValueCodec(base) : base;
}

function rootBaseResponseSchema(
  registry: NodeRegistry,
  plan: RootPlan,
  selection: Selection | undefined,
): DynamicCodec {
  switch (plan._tag) {
    case "ObjectRoot":
      return nodeToResponseSchema(registry, plan.schemaTarget, selection ?? {});
    case "ArrayRoot":
      return arrayCodec(rootElementToResponseSchema(registry, plan.element, selection ?? {}));
    case "OpaqueRoot":
      return codecFromAst(plan.codecAst);
  }
}

function opaqueRootSelectionError(reason: string | undefined): Error {
  const suffix = reason ? `: ${reason}` : "";
  return new Error(`responseSchema: opaque root does not accept a selection${suffix}`);
}

function rootElementToResponseSchema(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection,
): DynamicCodec {
  const typeAst = unwrapType(ast);
  if (isNullable(typeAst)) {
    return noneOrValueCodec(
      rootElementToResponseSchema(registry, nonNullishRootAst(typeAst), selection),
    );
  }
  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    if (!inner) return arrayCodec(unknownCodec);
    return arrayCodec(rootElementToResponseSchema(registry, inner, selection));
  }
  return nodeToResponseSchema(registry, typeAst, selection);
}

function nodeToResponseSchema(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
  selection: Selection,
): DynamicCodec {
  const selectionKey = cacheKey(selection);
  const cached = getCached(nodeResponseCache, ast, selectionKey);
  if (cached) return cached;

  const realized: { value?: DynamicCodec } = {};
  const placeholder = suspendCodec(() => {
    if (!realized.value) {
      throw new Error("responseSchema: placeholder forced before realization");
    }
    return realized.value;
  });
  setCached(nodeResponseCache, ast, selectionKey, placeholder);

  // The placeholder is cached before the build so recursive references
  // resolve; if the build throws (unknown field, duplicate output key), the
  // never-realized placeholder must not survive as a poisoned cache entry.
  try {
    const fields: Record<string, DynamicCodec> = Object.create(null);
    let plan: SelectedNodePlan;
    try {
      plan = planSelectedNode(registry, ast, selection);
    } catch (error) {
      if (error instanceof DuplicateOutputKey) {
        throw new Error(
          `responseSchema: duplicate output key "${error.outputKey}" in selection (use aliases to disambiguate)`,
        );
      }
      if (error instanceof UndefinedSelectionEntry) {
        throw new Error(`responseSchema: undefined selection entry "${error.fieldName}"`);
      }
      throw error;
    }

    for (const field of plan.fields) {
      if (field.fieldAsts.length === 0) {
        throw new Error(`responseSchema: unknown selection field "${field.entry.fieldName}"`);
      }
      fields[field.entry.outputKey] = unionCodec(
        field.fieldAsts.map((fieldAst) => fieldSuccessSchema(registry, fieldAst, field)),
      );
    }
    const built = structCodec(fields);
    realized.value = built;
    setCached(nodeResponseCache, ast, selectionKey, built);
    return built;
  } catch (error) {
    nodeResponseCache.get(ast)?.delete(selectionKey);
    throw error;
  }
}

function fieldSuccessSchema(
  registry: NodeRegistry,
  fieldAst: SchemaAST.AST,
  field: SelectedFieldPlan,
): DynamicCodec {
  const sub = field.entry.select;
  if (!sub) return codecFromAst(fieldAst);

  const typeAst = unwrapType(fieldAst);
  if (SchemaAST.isUndefined(typeAst)) return codecFromAst(typeAst);
  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    if (!inner) return arrayCodec(unknownCodec);
    const innerSchema = rootElementToResponseSchema(registry, inner, sub);
    return arrayCodec(innerSchema);
  }
  if (isNullable(typeAst)) {
    return noneOrValueCodec(
      rootToResponseSchemaInternal(registry, nonNullishRootAst(typeAst), sub),
    );
  }
  return nodeToResponseSchema(registry, typeAst, sub);
}

// The walker normalizes nullish sub-selected values to `null` (plain data,
// JSON-native), so the nullable slot on the wire is a bare null.
function noneOrValueCodec(value: DynamicCodec): DynamicCodec {
  return unionCodec([unsafeCoerceCodec(Schema.Null), value]);
}

function cacheKey(selection: Selection | undefined): string {
  return JSON.stringify(canonicalizeSelection(selection) ?? null);
}

function getCached(
  cache: WeakMap<SchemaAST.AST, Map<string, DynamicCodec>>,
  ast: SchemaAST.AST,
  selectionKey: string,
): DynamicCodec | undefined {
  return cache.get(ast)?.get(selectionKey);
}

function setCached(
  cache: WeakMap<SchemaAST.AST, Map<string, DynamicCodec>>,
  ast: SchemaAST.AST,
  selectionKey: string,
  schema: DynamicCodec,
): void {
  let bySelection = cache.get(ast);
  if (!bySelection) {
    bySelection = new Map();
    cache.set(ast, bySelection);
  }
  bySelection.set(selectionKey, schema);
}
