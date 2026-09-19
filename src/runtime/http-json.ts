/**
 * Interpreter for `http-json` recipes: fetch JSON, walk to the record array,
 * read each field by path. No eval, no model, no site-specific branches.
 */
import type { HttpJsonRecipe } from "../shared/recipe.js";
import type { RawRecord } from "../shared/schema.js";
import { pilotError } from "../shared/errors.js";
import { fillTemplate, fillUrl } from "./template.js";

const USER_AGENT = "Pilot/0.1 (+https://github.com/pilot)";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Walk a dotted path like `data.results[0].name`. Returns `undefined` if it doesn't resolve. */
export function readPath(value: unknown, pathExpr: string): unknown {
  if (pathExpr === "$" || pathExpr === "") return value;
  let current = value;
  for (const rawSegment of pathExpr.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (rawSegment === "") continue;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(rawSegment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[rawSegment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Flatten whatever a path resolved to into a display string. */
function stringify(value: unknown, joinWith: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringify(item, joinWith)).filter((item): item is string => !!item);
    return parts.length > 0 ? parts.join(joinWith) : null;
  }
  if (typeof value === "object") {
    // Objects that wrap a single display value are extremely common
    // (`{"name": "Boston, MA"}`), so reach one level in before giving up.
    const record = value as Record<string, unknown>;
    for (const key of ["name", "label", "text", "value", "title"]) {
      const inner = record[key];
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
  }
  return null;
}

export async function executeHttpJsonRecipe(
  recipe: HttpJsonRecipe,
  variables: Record<string, string | number>,
  options: { signal?: AbortSignal } = {},
): Promise<RawRecord[]> {
  const pages = recipe.pagination?.kind === "counter" ? recipe.pagination.maxPages : 1;
  const records: RawRecord[] = [];

  for (let page = 0; page < pages; page += 1) {
    const pageVariables = { ...variables };
    if (recipe.pagination?.kind === "counter") {
      const { variable, start, step } = recipe.pagination;
      pageVariables[variable] = start + page * step;
    }

    const url = fillUrl(recipe.request.urlTemplate, pageVariables);
    let response: Response;
    try {
      response = await fetch(url, {
        method: recipe.request.method,
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...recipe.request.headers },
        body: recipe.request.bodyTemplate
          ? fillTemplate(recipe.request.bodyTemplate, pageVariables)
          : undefined,
        signal: options.signal,
      });
    } catch (cause) {
      throw pilotError("SOURCE_UNAVAILABLE", `Request to ${url} failed: ${(cause as Error).message}`);
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw pilotError("RATE_LIMITED", `${url} rate limited this request`, {
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      });
    }
    if (response.status === 403) {
      throw pilotError("BLOCKED", `${url} refused the request (403). This site may require a browser recipe.`);
    }
    if (!response.ok) {
      throw pilotError("SOURCE_UNAVAILABLE", `${url} returned HTTP ${response.status}`);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw pilotError("INVALID_SOURCE_RESPONSE", `${url} returned more than ${MAX_RESPONSE_BYTES} bytes`);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw pilotError("INVALID_SOURCE_RESPONSE", `${url} did not return JSON`);
    }

    const rows = readPath(body, recipe.recordsPath);
    if (!Array.isArray(rows)) {
      // The shape changed underneath the recipe. That is a broken Pilot, not a
      // transient failure, and the compiler's repair path is what fixes it.
      throw pilotError(
        "PILOT_BROKEN",
        `Expected an array at "${recipe.recordsPath}" in the response from ${url}`,
      );
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      if (recipe.exclude.some((rule) => readPath(row, rule.path) === rule.equals)) continue;
      records.push(extractRecord(row, recipe));
    }
  }

  return records;
}

function extractRecord(row: unknown, recipe: HttpJsonRecipe): RawRecord {
  const record: RawRecord = {};
  for (const [field, spec] of Object.entries(recipe.fields)) {
    let value: string | null = null;
    for (const source of spec.sources) {
      value = stringify(readPath(row, source.path), source.joinWith ?? "; ");
      if (value !== null) break;
    }
    if (value === null && !spec.allowMissing) {
      throw pilotError("PILOT_BROKEN", `Required field "${field}" was missing from a record`);
    }
    record[field] = value;
  }
  return record;
}
