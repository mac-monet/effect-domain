import { normalizeEntry, parseSelection, type Selection } from "./syntax.ts";

/**
 * One selected field in an analyzed selection: its output path from the
 * root, the source field name, and the (possibly aliased) output key.
 *
 * @since 0.1.0
 * @category models
 */
export interface SelectionFieldInfo {
  readonly path: ReadonlyArray<string>;
  readonly fieldName: string;
  readonly outputKey: string;
}

/**
 * Structural facts about a selection — max nesting depth, total field count,
 * and the flat field list — for gateway policy checks (depth limits, field
 * allowlists, complexity budgets) before resolvers run.
 *
 * @since 0.1.0
 * @category models
 */
export interface SelectionAnalysis {
  readonly depth: number;
  readonly fieldCount: number;
  readonly fields: ReadonlyArray<SelectionFieldInfo>;
}

function analyze(
  selection: Selection | undefined,
  parentPath: ReadonlyArray<string>,
): SelectionAnalysis {
  if (selection === undefined) {
    return { depth: 0, fieldCount: 0, fields: [] };
  }

  const parsed = parseSelection(selection);
  let maxChildDepth = 0;
  let fieldCount = 0;
  const fields: SelectionFieldInfo[] = [];

  for (const entry of parsed) {
    fieldCount++;
    const path = [...parentPath, entry.outputKey];
    fields.push({
      path,
      fieldName: entry.fieldName,
      outputKey: entry.outputKey,
    });

    const raw = selection[entry.fieldName];
    for (const item of normalizeEntry(raw!)) {
      if ((item.alias ?? entry.fieldName) !== entry.outputKey) continue;
      const child = analyze(item.select, path);
      maxChildDepth = Math.max(maxChildDepth, child.depth);
      fieldCount += child.fieldCount;
      fields.push(...child.fields);
    }
  }

  return {
    depth: parsed.length === 0 ? 0 : maxChildDepth + 1,
    fieldCount,
    fields,
  };
}

/**
 * Analyzes a (validated) selection without executing anything. Exposed on
 * prepared dispatches as `prepared.analysis` so gateways can enforce depth /
 * field-count limits before calling `prepared.execute`.
 *
 * @example
 * ```ts
 * import { analyzeSelection } from "effect-domain"
 *
 * const analysis = analyzeSelection({ id: true, posts: { select: { title: true } } })
 * // → { depth: 2, fieldCount: 3, fields: [...] }
 * if (analysis.depth > 5) throw new Error("selection too deep")
 * ```
 *
 * @since 0.1.0
 * @category utilities
 */
export function analyzeSelection(selection: Selection | undefined): SelectionAnalysis {
  return analyze(selection, []);
}
