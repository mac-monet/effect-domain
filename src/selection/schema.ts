import { Schema, SchemaAST } from "effect";
import type { StoredFieldDef } from "../define.ts";
import type { NodeRegistry } from "../registry.ts";
import {
  arrayCodec,
  type DynamicCodec,
  optionalCodec,
  structCodec,
  suspendCodec,
  unionCodec,
  unsafeCoerceCodec,
} from "../schema/codec.ts";
import { fieldSelectionProjection, type OpaqueRootReason } from "./projection.ts";
import { unwrapSuspend } from "../schema/ast.ts";
import { collectSentinels } from "../schema/sentinels.ts";
import { duplicateSelectionOutputKeys, type Selection } from "./syntax.ts";

const TRUE_LITERAL = unsafeCoerceCodec(Schema.Literal(true));

// Selection codecs derive purely from AST identity, so caches are
// module-global WeakMaps: entries are shared across graphs that reference the
// same node ASTs and are GC'd with them. Invariant: builders receive a
// registry, but every registry-derived answer they consume (fieldDefsFor,
// sentinels, rootPlanFor) must be a pure function of the AST — otherwise a
// codec built through one graph's registry would be wrong for another graph
// sharing the same AST. Only name-keyed lookups are
// per-graph (see graph/runtime.ts). The per-field cache nests
// fieldTypeAst → fieldName → stored args decoder.
const nodeSchemaCache = new WeakMap<SchemaAST.AST, DynamicCodec>();
const rootSchemaCache = new WeakMap<SchemaAST.AST, DynamicCodec>();
const perFieldSchemaCache = new WeakMap<
  SchemaAST.AST,
  Map<string, Map<DynamicCodec | undefined, DynamicCodec>>
>();

function isUnionDiscriminated(registry: NodeRegistry, union: SchemaAST.Union): boolean {
  const objectVariants: SchemaAST.AST[] = [];
  for (const variant of union.types) {
    const unwrapped = unwrapSuspend(variant);
    if (SchemaAST.isObjects(unwrapped)) objectVariants.push(unwrapped);
  }
  if (objectVariants.length <= 1) return true;
  for (const variant of objectVariants) {
    // Registered nodes carry precomputed sentinels; anonymous variants fall
    // back to extraction from the encoded AST.
    const sentinels =
      registry.lookup(variant)?.sentinels ?? collectSentinels(SchemaAST.toEncoded(variant));
    if (sentinels.length === 0) return false;
  }
  return true;
}

function withArrayForm(structSchema: DynamicCodec, implicitAlias: string): DynamicCodec {
  const arrayElement = unionCodec([TRUE_LITERAL, structSchema]);
  const arrayForm = unsafeCoerceCodec(
    arrayCodec(arrayElement).pipe(
      Schema.refine(
        (arr: unknown): arr is ReadonlyArray<unknown> =>
          Array.isArray(arr) &&
          arr.length > 0 &&
          duplicateSelectionOutputKeys({ [implicitAlias]: arr }).length === 0,
      ),
    ),
  );
  return unionCodec([TRUE_LITERAL, structSchema, arrayForm]);
}

function strictStruct(fields: Record<string, DynamicCodec>): DynamicCodec {
  const allowed = new Set(Object.keys(fields));
  const inner = structCodec(fields);
  return strictRecord(allowed, inner);
}

function perFieldScalarSelection(
  fieldName: string,
  argsSchema: DynamicCodec | undefined,
): DynamicCodec {
  const fields: Record<string, DynamicCodec> = {
    alias: optionalCodec(unsafeCoerceCodec(Schema.String)),
  };
  if (argsSchema) {
    fields.args = optionalCodec(argsSchema);
  }
  const struct = strictStruct(fields);
  return withArrayForm(struct, fieldName);
}

function perFieldObjectSelection(
  registry: NodeRegistry,
  fieldName: string,
  targetAst: SchemaAST.AST,
  argsSchema: DynamicCodec | undefined,
): DynamicCodec {
  const childSchema = nodeToSelectionSchemaInternal(registry, targetAst);

  const fields: Record<string, DynamicCodec> = {
    select: optionalCodec(childSchema),
    alias: optionalCodec(unsafeCoerceCodec(Schema.String)),
  };
  if (argsSchema) {
    fields.args = optionalCodec(argsSchema);
  }
  const struct = strictStruct(fields);
  return withArrayForm(struct, fieldName);
}

function getOrBuildPerField(
  registry: NodeRegistry,
  fieldName: string,
  fieldTypeAst: SchemaAST.AST,
  argsSchema: DynamicCodec | undefined,
): DynamicCodec {
  let fieldsMap = perFieldSchemaCache.get(fieldTypeAst);
  if (!fieldsMap) {
    fieldsMap = new Map();
    perFieldSchemaCache.set(fieldTypeAst, fieldsMap);
  }
  let argsMap = fieldsMap.get(fieldName);
  if (!argsMap) {
    argsMap = new Map();
    fieldsMap.set(fieldName, argsMap);
  }
  const cached = argsMap.get(argsSchema);
  if (cached) return cached;

  const projection = fieldSelectionProjection(fieldTypeAst);
  const built =
    projection._tag === "Nested"
      ? perFieldObjectSelection(registry, fieldName, projection.target, argsSchema)
      : perFieldScalarSelection(fieldName, argsSchema);
  argsMap.set(argsSchema, built);
  return built;
}

function collectVariantFields(
  registry: NodeRegistry,
  variantAst: SchemaAST.Objects,
  out: Map<string, Set<DynamicCodec>>,
  childTypesByName: Map<string, Set<SchemaAST.AST | "scalar">> | undefined,
): void {
  const fieldDefs = registry.fieldDefsFor(variantAst);
  const computedNames = new Set<string>(fieldDefs ? Object.keys(fieldDefs) : []);

  for (const ps of variantAst.propertySignatures) {
    if (typeof ps.name !== "string") continue;
    if (computedNames.has(ps.name)) continue;
    const schema = getOrBuildPerField(registry, ps.name, ps.type, undefined);
    let set = out.get(ps.name);
    if (!set) {
      set = new Set();
      out.set(ps.name, set);
    }
    set.add(schema);
    if (childTypesByName) {
      const projection = fieldSelectionProjection(ps.type);
      let cset = childTypesByName.get(ps.name);
      if (!cset) {
        cset = new Set();
        childTypesByName.set(ps.name, cset);
      }
      cset.add(projection._tag === "Nested" ? projection.target : "scalar");
    }
  }

  if (fieldDefs) {
    for (const [name, def] of Object.entries(fieldDefs)) {
      const stored = def as StoredFieldDef<unknown>;
      // Computed args decoders are already constrained to never require
      // services; selection synthesis only needs them as runtime codecs.
      const argsSchema =
        stored._kind === "computed"
          ? (stored.args as unknown as DynamicCodec | undefined)
          : undefined;
      const schema = getOrBuildPerField(registry, name, def.type.ast, argsSchema);
      let set = out.get(name);
      if (!set) {
        set = new Set();
        out.set(name, set);
      }
      set.add(schema);
      if (childTypesByName) {
        const projection = fieldSelectionProjection(def.type.ast);
        let cset = childTypesByName.get(name);
        if (!cset) {
          cset = new Set();
          childTypesByName.set(name, cset);
        }
        cset.add(projection._tag === "Nested" ? projection.target : "scalar");
      }
    }
  }
}

function selectionOutputKeyIssues(v: Record<string, unknown>): Array<Schema.FilterIssue> {
  return duplicateSelectionOutputKeys(v).map(({ fieldName, outputKey }) => ({
    path: [fieldName],
    issue: `duplicate output key "${outputKey}" in selection`,
  }));
}

function strictRecord(
  allowed: ReadonlySet<string>,
  inner: DynamicCodec,
  validateOutputKeys = false,
): DynamicCodec {
  const validated = Schema.Unknown.pipe(
    Schema.refine(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
      {
        message:
          "Expected a selection object (selections are always explicit; there is no implicit full selection)",
      },
    ),
    Schema.check(
      Schema.makeFilter((v: Record<string, unknown>) => {
        const issues: Array<Schema.FilterIssue> = [];
        for (const k of Object.keys(v)) {
          if (v[k] === undefined) {
            issues.push({
              path: [k],
              issue: `undefined selection entry "${k}"`,
            });
            continue;
          }
          if (!allowed.has(k)) {
            issues.push({
              path: [k],
              issue: `unknown selection key "${k}" — not a field on this node`,
            });
          }
        }
        if (validateOutputKeys) {
          issues.push(...selectionOutputKeyIssues(v));
        }
        return issues.length === 0 ? undefined : issues;
      }),
    ),
  );
  return unsafeCoerceCodec(validated.pipe(Schema.decodeTo(inner)));
}

function nodeToSelectionSchemaInternal(registry: NodeRegistry, ast: SchemaAST.AST): DynamicCodec {
  const cached = nodeSchemaCache.get(ast);
  if (cached) return cached;

  const realized: { value?: DynamicCodec } = {};
  const placeholder = suspendCodec(() => {
    if (!realized.value) {
      throw new Error("selectionSchema: placeholder forced before realization");
    }
    return realized.value;
  });
  nodeSchemaCache.set(ast, placeholder);

  const typeAst = unwrapSuspend(ast);
  const built = buildSelectionSchema(registry, typeAst);
  realized.value = built;
  nodeSchemaCache.set(ast, built);
  return built;
}

function buildSelectionSchema(registry: NodeRegistry, typeAst: SchemaAST.AST): DynamicCodec {
  if (SchemaAST.isUnion(typeAst)) {
    if (!isUnionDiscriminated(registry, typeAst)) {
      throw new Error(
        "selectionSchema: cannot derive a selection Schema for a non-sentinel-discriminated union",
      );
    }
    const fieldsByName = new Map<string, Set<DynamicCodec>>();
    // Tracks each field's selection projection per variant — including a
    // "scalar" marker, so a field that is sub-selectable on one variant but
    // scalar on another is rejected as ambiguous rather than accepted at the
    // boundary and then rejected (or worse) by the response codec.
    const childTypesByName = new Map<string, Set<SchemaAST.AST | "scalar">>();
    for (const variant of typeAst.types) {
      const variantType = unwrapSuspend(variant);
      if (!SchemaAST.isObjects(variantType)) continue;
      collectVariantFields(registry, variantType, fieldsByName, childTypesByName);
    }
    for (const [name, types] of childTypesByName) {
      if (types.size > 1) {
        throw new Error(
          `selectionSchema: union has field "${name}" with conflicting scalar/object/array types across variants — selection sub-shapes would be ambiguous at the boundary. Rename the field on one variant or align the underlying type.`,
        );
      }
    }
    const merged = new Map<string, DynamicCodec>();
    for (const [name, schemas] of fieldsByName) {
      merged.set(name, unionCodec(Array.from(schemas)));
    }
    return finalizeStruct(merged);
  }

  if (SchemaAST.isObjects(typeAst)) {
    const fieldsByName = new Map<string, Set<DynamicCodec>>();
    collectVariantFields(registry, typeAst, fieldsByName, undefined);
    const merged = new Map<string, DynamicCodec>();
    for (const [name, schemas] of fieldsByName) {
      merged.set(name, unionCodec(Array.from(schemas)));
    }
    return finalizeStruct(merged);
  }

  if (SchemaAST.isArrays(typeAst)) {
    const inner = typeAst.rest[0];
    if (inner) {
      return nodeToSelectionSchemaInternal(registry, inner);
    }
  }

  return finalizeStruct(new Map());
}

function finalizeStruct(entries: Map<string, DynamicCodec>): DynamicCodec {
  const fields: Record<string, DynamicCodec> = {};
  const allowed = new Set<string>();
  for (const [name, schema] of entries) {
    fields[name] = optionalCodec(schema);
    allowed.add(name);
  }
  const inner = structCodec(fields);
  return strictRecord(allowed, inner, true);
}

/**
 * Builds a `Codec<Selection, unknown, never, never>` mirroring the runtime
 * selection shape for a node AST. Internal construction uses an erased
 * `DynamicCodec` (necessary for variance through the recursive AST walk); the
 * cast at the boundary concentrates the variance fudge in one place so
 * callers stay typed without leaking unknown decoding services.
 */
export type SelectionCodec = Schema.Codec<Selection, unknown, never, never>;
export type RootSelectionCodec = Schema.Codec<Selection | undefined, unknown, never, never>;

export function nodeToSelectionSchema(registry: NodeRegistry, ast: SchemaAST.AST): SelectionCodec {
  return selectionCodec(nodeToSelectionSchemaInternal(registry, ast));
}

function noSelectionSchema(reason: OpaqueRootReason | undefined): DynamicCodec {
  const suffix = reason ? `: ${reason}` : "";
  return unsafeCoerceCodec(
    Schema.Unknown.pipe(
      Schema.refine((v): v is undefined => v === undefined, {
        message: `opaque root does not accept a selection${suffix}`,
      }),
    ),
  );
}

export function rootToSelectionSchema(
  registry: NodeRegistry,
  ast: SchemaAST.AST,
): RootSelectionCodec {
  const cached = rootSchemaCache.get(ast);
  if (cached) return rootSelectionCodec(cached);
  const built = rootToSelectionSchemaInternal(registry, ast);
  rootSchemaCache.set(ast, built);
  return rootSelectionCodec(built);
}

function rootToSelectionSchemaInternal(registry: NodeRegistry, ast: SchemaAST.AST): DynamicCodec {
  const plan = registry.rootPlanFor(ast);
  switch (plan._tag) {
    // Node roots require an explicit selection — there is no implicit
    // "select everything", so an omitted select is a decode error rather
    // than an empty projection.
    case "ObjectRoot":
      return nodeToSelectionSchemaInternal(registry, plan.schemaTarget);
    case "ArrayRoot":
      return nodeToSelectionSchemaInternal(registry, plan.selectionTarget);
    case "OpaqueRoot":
      return noSelectionSchema(plan.reason);
  }
}

function selectionCodec(codec: DynamicCodec): SelectionCodec {
  // Public boundary: the dynamic schema mirrors Selection at runtime, while the
  // recursive builder erases exact shape internally.
  return codec as unknown as SelectionCodec;
}

function rootSelectionCodec(codec: DynamicCodec): RootSelectionCodec {
  // Public boundary: scalar (opaque) roots allow omitted selection; node
  // roots require one.
  return codec as unknown as RootSelectionCodec;
}
