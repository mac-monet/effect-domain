import { Option, Result } from "effect";

/**
 * A location in a result tree: object keys and array indices from the root.
 *
 * @since 0.1.0
 * @category models
 */
export type Path = ReadonlyArray<string | number>;

/**
 * @since 0.1.0
 * @category models
 */
export interface PathEntry {
  readonly path: Path;
  readonly result: Result.Result<unknown, unknown>;
}

/**
 * Flattens a walked result tree into `{ path, result }` entries — one per
 * field-level `Result`, including nested ones under successes. The walker
 * itself tracks no paths; consumers that need a flat view (protocol adapters
 * building error arrays, structured logging) derive it here instead.
 *
 * @example
 * ```ts
 * import { Result } from "effect"
 * import { annotatePaths } from "effect-domain"
 *
 * const tree = yield* graph.execute("getUser", { select: { id: true, posts: { select: { title: true } } } })
 * const errors = annotatePaths(tree).filter(({ result }) => Result.isFailure(result))
 * // → [{ path: ["posts", 0, "title"], result: Result.Failure(...) }, ...]
 * ```
 *
 * @since 0.1.0
 * @category utilities
 */
export function annotatePaths(tree: unknown): ReadonlyArray<PathEntry> {
  const entries: PathEntry[] = [];
  visit(tree, [], entries);
  return entries;
}

function visit(node: unknown, path: Path, entries: PathEntry[]): void {
  if (Result.isResult(node)) {
    entries.push({ path, result: node });
    if (Result.isSuccess(node)) {
      visit(node.success, path, entries);
    }
    return;
  }
  if (Option.isOption(node)) return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => visit(item, [...path, i], entries));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(value, [...path, key], entries);
    }
  }
}
