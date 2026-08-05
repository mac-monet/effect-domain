import { sha256Hex } from "./internal/sha256.ts";

/**
 * The canonical invocation shape hashed by {@link invocationKey}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Invocation {
  readonly name: string;
  readonly args?: unknown;
  readonly select?: unknown;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface InvocationKeyOptions {
  /**
   * Number of SHA-256 digest bytes to keep. Defaults to 8 bytes (16 hex chars).
   * Use 16 or 32 bytes for durable/global idempotency keys.
   */
  readonly bytes?: number;
}

function keyBytes(options: InvocationKeyOptions | undefined): number {
  const bytes = options?.bytes ?? 8;
  if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > 32) {
    throw new RangeError("invocationKey bytes must be a safe integer between 8 and 32.");
  }
  return bytes;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    // Only recurse into plain objects. Non-plain values (Date, Map, Set, URL,
    // class instances) are passed through so JSON.stringify can apply its own
    // serialization rules (toJSON for Date / URL, default {} for Map / Set,
    // own enumerable keys for class instances). Rebuilding via Object.keys
    // would silently strip non-enumerable structure and collide distinct
    // values to identical keys — see the JSDoc on `invocationKey`.
    if (!isPlainObject(value)) return value;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) out[key] = sortKeysDeep(obj[key]);
    return out;
  }
  return value;
}

function canonicalizeFieldItem(item: unknown): true | Record<string, unknown> {
  if (item === true) return true;
  if (item === null || typeof item !== "object" || Array.isArray(item)) return true;
  const it = item as { args?: unknown; select?: unknown; alias?: unknown };
  const out: Record<string, unknown> = {};
  if (it.alias !== undefined) out.alias = it.alias;
  if (it.args !== undefined) out.args = sortKeysDeep(it.args);
  if (it.select !== undefined) {
    // An empty select block is NOT equivalent to `true`: `{ select: {} }`
    // projects the value to `{}` while `true` passes it through raw. Keep it
    // distinct so invocation keys and response-codec cache keys don't collide
    // across selections that produce different data.
    out.select = canonicalizeSelection(it.select) ?? {};
  }
  return Object.keys(out).length === 0 ? true : out;
}

function aliasOf(item: true | Record<string, unknown>): string {
  if (item === true) return "";
  return typeof item.alias === "string" ? item.alias : "";
}

function canonicalizeFieldEntry(
  entry: unknown,
): true | Record<string, unknown> | ReadonlyArray<true | Record<string, unknown>> {
  if (Array.isArray(entry)) {
    const items = entry.map(canonicalizeFieldItem);
    if (items.length === 1) return items[0]!;
    const sorted = [...items].sort((a, b) => {
      const aa = aliasOf(a);
      const ab = aliasOf(b);
      return aa < ab ? -1 : aa > ab ? 1 : 0;
    });
    return sorted;
  }
  return canonicalizeFieldItem(entry);
}

function canonicalizeSelectionInner(select: unknown): Record<string, unknown> | undefined {
  if (select === null || typeof select !== "object" || Array.isArray(select)) return undefined;
  const obj = select as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = canonicalizeFieldEntry(obj[key]);
  }
  return out;
}

/**
 * Canonical, deterministic form of a selection.
 *
 * - Recursively sorts object keys.
 * - Collapses single-entry arrays to their scalar form (`[true] → true`,
 *   `[{ alias: "x", args: {...} }] → { alias: "x", args: {...} }`) — the
 *   bare and single-element-array forms are semantically equivalent in the
 *   walker, so they share a key.
 * - Sorts multi-alias array entries by alias (empty alias sorts first).
 * - Drops empty `select: {}` blocks (treated as absent).
 * - Normalizes a leaf entry to `true` when no args / select / alias remain.
 *
 * Returns `undefined` for non-object inputs (treated as "no selection") so
 * `select: {}` and `select: undefined` produce the same canonical form.
 *
 * Non-`true` scalar leaves (numbers, strings, `false`, `null`) are coerced
 * to `true` — invalid selection shapes are caught earlier by the gateway's
 * `selectionSchema` decode; this canonicalizer is intentionally permissive.
 *
 * @since 0.1.0
 * @category utilities
 */
export function canonicalizeSelection(select: unknown): Record<string, unknown> | undefined {
  const inner = canonicalizeSelectionInner(select);
  if (inner === undefined) return undefined;
  return Object.keys(inner).length === 0 ? undefined : inner;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.hasOwn(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Structural equality on two selections. Cheaper than hashing for in-process
 * comparison: matches `invocationKey`'s notion of equality (key order, single
 * vs. array form, multi-alias order, empty `select: {}` blocks all agree).
 *
 * @since 0.1.0
 * @category utilities
 */
export function selectionsEqual(a: unknown, b: unknown): boolean {
  return deepEqual(canonicalizeSelection(a), canonicalizeSelection(b));
}

/**
 * Canonical truncated SHA-256 over `(name, args, select)`. Stable across key
 * order, `[true]` ↔ `true`, multi-alias entry order, and empty `select: {}`.
 *
 * Args are key-sorted recursively but NOT empty-normalized — `args: {}` and
 * `args: undefined` produce different keys (the operation defines that
 * equivalence; the key respects the call shape verbatim).
 *
 * Defaults to 8 bytes / 16 hex chars for compact cache keys. Use 16 or 32 bytes
 * for durable/global idempotency keys.
 *
 * **Args must be JSON-serializable for keys to be stable.** Plain objects,
 * arrays, and scalars are canonicalized losslessly. Values with a `toJSON`
 * method (e.g. `Date`, `URL`) serialize via that method. Values without
 * (`Map`, `Set`, class instances with non-enumerable state) JSON-serialize
 * to `{}` and will collide with each other — pass canonical, JSON-shaped
 * args, or pre-serialize them at the call site.
 *
 * @example
 * ```ts
 * import { invocationKey } from "effect-domain"
 *
 * // Same key regardless of key order and selection surface form
 * invocationKey({ name: "getUser", args: { id: "1" }, select: { id: true } })
 * // durable idempotency key for a workflow step
 * invocationKey({ name: "chargeCard", args }, { bytes: 32 })
 * ```
 *
 * @since 0.1.0
 * @category utilities
 */
export function invocationKey(invocation: Invocation, options?: InvocationKeyOptions): string {
  const canonical = {
    name: invocation.name,
    args: invocation.args === undefined ? undefined : sortKeysDeep(invocation.args),
    select: canonicalizeSelection(invocation.select),
  };
  const json = JSON.stringify(canonical);
  return sha256Hex(json).slice(0, keyBytes(options) * 2);
}
