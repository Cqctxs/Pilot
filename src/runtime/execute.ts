/**
 * The single entry point for running a compiled Pilot.
 *
 * Nothing below this line calls a model. Once a Pilot exists, searching is
 * ordinary deterministic code — that is the whole point of compiling.
 */
import type { Pilot } from "../shared/pilot.js";
import type { RawRecord } from "../shared/schema.js";
import { executeHttpJsonRecipe } from "./http-json.js";
import { executeBrowserRecipe } from "./browser.js";

export interface ExecuteOptions {
  /** Bound into the recipe's URL template: query terms, tenant slugs, page numbers. */
  variables?: Record<string, string | number>;
  signal?: AbortSignal;
}

export async function executePilot(
  pilot: Pilot,
  options: ExecuteOptions = {},
): Promise<RawRecord[]> {
  const variables = options.variables ?? {};
  const records =
    pilot.recipe.kind === "http-json"
      ? await executeHttpJsonRecipe(pilot.recipe, variables, { signal: options.signal })
      : await executeBrowserRecipe(pilot.recipe, variables);
  return records.map((record) => coerce(record, pilot));
}

/** Resolve relative URLs against the target so callers always get a clickable link. */
function coerce(record: RawRecord, pilot: Pilot): RawRecord {
  const out: RawRecord = { ...record };
  for (const field of pilot.schema.fields) {
    const value = out[field.name];
    if (field.type === "url" && value) {
      try {
        out[field.name] = new URL(value, pilot.target.url).toString();
      } catch {
        out[field.name] = value;
      }
    }
  }
  return out;
}
