/**
 * The untyped per-field selection entry: optional resolver `args`, a nested
 * `select` block for object-typed fields, and an `alias` renaming the output
 * key.
 *
 * @since 0.1.0
 * @category models
 */
export interface FieldSelection {
  readonly args?: Record<string, unknown>;
  readonly select?: Selection;
  readonly alias?: string;
}

/**
 * The runtime selection shape: field names mapped to `true`, a
 * {@link FieldSelection}, or an array of entries (multi-alias — select the
 * same field several times under different output keys). Typed call sites
 * use {@link SelectionFor} / {@link RootSelectionFor} instead.
 *
 * @since 0.1.0
 * @category models
 */
export type Selection = Record<
  string,
  true | FieldSelection | ReadonlyArray<true | FieldSelection>
>;

export interface ParsedFieldEntry {
  readonly fieldName: string;
  readonly outputKey: string;
  readonly args?: Record<string, unknown>;
  readonly select?: Selection;
}

export type ParsedSelection = ReadonlyArray<ParsedFieldEntry>;

export class DuplicateOutputKey extends Error {
  constructor(readonly outputKey: string) {
    super(`duplicate output key "${outputKey}" in selection`);
  }
}

export class UndefinedSelectionEntry extends Error {
  constructor(readonly fieldName: string) {
    super(`undefined selection entry "${fieldName}"`);
  }
}

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
export type HasArrayMember<T> = [Extract<NonNullable<T>, readonly unknown[]>] extends [never]
  ? false
  : true;
export type UnionKeys<T> = T extends unknown ? keyof T : never;
export type ValueForKey<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

interface ScalarFieldSelection {
  readonly args?: Record<string, unknown>;
  readonly alias?: string;
}

interface TypedFieldSelection<T> {
  readonly select?: SelectionFor<T>;
  readonly args?: Record<string, unknown>;
  readonly alias?: string;
}

type FieldEntryValue<T> = [NonNullable<T>] extends [readonly (infer E)[]]
  ? [E] extends [Record<string, any>]
    ? IsUnion<E> extends true
      ? FieldSelection
      : TypedFieldSelection<E>
    : ScalarFieldSelection
  : [NonNullable<T>] extends [Record<string, any>]
    ? IsUnion<NonNullable<T>> extends true
      ? FieldSelection
      : TypedFieldSelection<NonNullable<T>>
    : ScalarFieldSelection;

type FieldEntry<T> = true | FieldEntryValue<T> | ReadonlyArray<true | FieldEntryValue<T>>;

/**
 * Constrains a selection to the fields of `T`: scalar fields accept `true`
 * (plus `args`/`alias`), object and array-of-object fields additionally
 * accept a nested `select`. Invalid keys are type errors.
 *
 * @since 0.1.0
 * @category models
 */
export type SelectionFor<T> = {
  [K in keyof T & string]?: FieldEntry<T[K]>;
};

export type NodeSelectionFor<T> = SelectionFor<T>;

/**
 * Constrains an operation-root selection. Differs from {@link SelectionFor}
 * for arrays — `RootSelectionFor<User[]>` selects `User` fields, not array
 * properties — and is `never` for opaque (scalar) roots, so typed callers
 * cannot pass `select` at all.
 *
 * @since 0.1.0
 * @category models
 */
export type RootSelectionFor<T> = RootSelectionForDepth<T, [1, 1, 1, 1, 1]>;

type RootSelectionForDepth<T, Depth extends ReadonlyArray<unknown>> = Depth extends readonly [
  unknown,
  ...infer Rest,
]
  ? [NonNullable<T>] extends [readonly (infer E)[]]
    ? RootSelectionForDepth<E, Rest>
    : HasArrayMember<T> extends true
      ? never
      : [NonNullable<T>] extends [Record<string, any>]
        ? NodeSelectionForRootObject<NonNullable<T>>
        : never
  : never;

type NodeSelectionForRootObject<T> = {
  [K in UnionKeys<T> & string]?: FieldEntry<ValueForKey<T, K>>;
};

export function selectionKeys(selection: Selection): ReadonlySet<string> {
  return new Set(Object.keys(selection));
}

/**
 * The output-key rule, shared by the walker's parser and the selection
 * schema's decode-time validation: a string `alias` renames the output key;
 * any other entry shape keeps the field name.
 */
export function selectionOutputKey(fieldName: string, entry: unknown): string {
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const alias = (entry as { readonly alias?: unknown }).alias;
    if (typeof alias === "string") return alias;
  }
  return fieldName;
}

/**
 * Duplicate output keys across a selection's entries (array forms flattened),
 * in encounter order. Tolerates raw untyped entries so decode-time validation
 * and the typed parser share one rule.
 */
export function duplicateSelectionOutputKeys(
  selection: Readonly<Record<string, unknown>>,
): ReadonlyArray<{ readonly fieldName: string; readonly outputKey: string }> {
  const seen = new Set<string>();
  const duplicates: Array<{ readonly fieldName: string; readonly outputKey: string }> = [];
  for (const [fieldName, raw] of Object.entries(selection)) {
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      const outputKey = selectionOutputKey(fieldName, entry);
      if (seen.has(outputKey)) duplicates.push({ fieldName, outputKey });
      seen.add(outputKey);
    }
  }
  return duplicates;
}

export function normalizeEntry(
  entry: true | FieldSelection | ReadonlyArray<true | FieldSelection>,
): ReadonlyArray<FieldSelection> {
  if (entry === true) return [{}];
  if (Array.isArray(entry)) return entry.map((e) => (e === true ? {} : (e as FieldSelection)));
  return [entry as FieldSelection];
}

export function parseSelection(selection: Selection): ParsedSelection {
  for (const [fieldName, raw] of Object.entries(selection)) {
    if (raw === undefined) {
      throw new UndefinedSelectionEntry(fieldName);
    }
  }
  const duplicate = duplicateSelectionOutputKeys(selection)[0];
  if (duplicate) {
    throw new DuplicateOutputKey(duplicate.outputKey);
  }

  const parsed: ParsedFieldEntry[] = [];
  for (const [fieldName, raw] of Object.entries(selection)) {
    for (const entry of normalizeEntry(raw)) {
      parsed.push({
        fieldName,
        outputKey: selectionOutputKey(fieldName, entry),
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.select !== undefined ? { select: entry.select } : {}),
      });
    }
  }

  return parsed;
}
