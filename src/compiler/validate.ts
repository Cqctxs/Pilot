/**
 * A recipe is only accepted if it actually pulls data off the live site.
 *
 * This is the gate that separates a compiler from a code generator: the model's
 * output is a candidate, and this decides whether it becomes a Pilot.
 */
import type { Recipe } from "../shared/recipe.js";
import type { DataSchema, RawRecord } from "../shared/schema.js";
import { executeHttpJsonRecipe } from "../runtime/http-json.js";
import { executeBrowserRecipe } from "../runtime/browser.js";
import { toPilotError } from "../shared/errors.js";

export interface ValidationReport {
  ok: boolean;
  records: RawRecord[];
  /** Human-readable reasons, fed straight back to the model on a retry. */
  problems: string[];
}

/** Required fields must be present on essentially every record, not just most. */
const REQUIRED_FIELD_COVERAGE = 0.9;

export async function validateRecipe(
  recipe: Recipe,
  schema: DataSchema,
  variables: Record<string, string | number> = {},
): Promise<ValidationReport> {
  let records: RawRecord[];
  try {
    records =
      recipe.kind === "http-json"
        ? await executeHttpJsonRecipe(recipe, variables)
        : await executeBrowserRecipe(recipe, variables);
  } catch (cause) {
    const error = toPilotError(cause);
    return { ok: false, records: [], problems: [`${error.code}: ${error.message}`] };
  }

  const problems: string[] = [];
  if (records.length === 0) {
    problems.push("The recipe ran but extracted zero records. Check recordsPath / rows.");
  }

  for (const field of schema.fields) {
    const present = records.filter((record) => record[field.name]).length;
    const coverage = records.length === 0 ? 0 : present / records.length;
    if (field.required && coverage < REQUIRED_FIELD_COVERAGE) {
      problems.push(
        `Required field "${field.name}" was found on only ${present}/${records.length} records. The path or locator is probably wrong.`,
      );
    }
    if (field.type === "url") {
      const bad = records.find((record) => record[field.name] && !isUrlish(record[field.name]!));
      if (bad) problems.push(`Field "${field.name}" is not a URL: ${JSON.stringify(bad[field.name])}`);
    }
  }

  // Every record identical usually means the row locator matched a container
  // rather than the repeating element.
  if (records.length > 1) {
    const first = JSON.stringify(records[0]);
    if (records.every((record) => JSON.stringify(record) === first)) {
      problems.push("Every record is identical — the row locator is matching the wrong element.");
    }
  }

  return { ok: problems.length === 0, records, problems };
}

function isUrlish(value: string): boolean {
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
