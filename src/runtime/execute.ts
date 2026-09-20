/**
 * The single entry point for running a compiled Pilot.
 *
 * Nothing reachable from here calls a model. Once a Pilot exists, searching is
 * ordinary deterministic code — that is the whole point of compiling.
 */
import type { LoadedPilot } from "../pilots/store.js";
import type { RawRecord, RawValue } from "../shared/schema.js";
import { runScript, type ScriptQuery } from "./script.js";
import { credentialValues } from "../integrations/apis.js";

export interface ExecuteOptions {
  query?: Partial<ScriptQuery>;
  timeoutMs?: number;
  onLog?: (message: string) => void;
}

export async function executePilot(
  loaded: LoadedPilot,
  options: ExecuteOptions = {},
): Promise<RawRecord[]> {
  const credentials = credentialValues(loaded.pilot.credentials ?? [], {
    projectRoot: loaded.projectRoot,
  });
  const query: ScriptQuery = {
    keywords: "",
    location: "",
    limit: null,
    ...loaded.config.variables,
    ...options.query,
    ...credentials,
  };

  const records = await runScript(loaded.pilot, loaded.dir, query, {
    timeoutMs: options.timeoutMs,
    onLog: options.onLog,
    sensitiveValues: Object.values(credentials),
  });

  return records.map((record) => coerce(record, loaded));
}

/**
 * Make each value the type its capability declared.
 *
 * A script reads text off a page, so everything arrives as a string. The
 * capability says `price` is a number, and until this ran, callers got `"133"`
 * and found out the hard way: `"143" < "9"` is true, so comparing prices across
 * sources silently keeps the wrong one. Only `url` was handled here before,
 * which is why the jobs path — the one with real normalization behind it —
 * looked fine while every other capability quietly did not.
 *
 * A value that cannot be read as its declared type becomes null rather than
 * staying a string. Null is a missing field, which required-field validation
 * already reports; a string in a number field is a wrong answer that type
 * checks.
 */
function coerce(record: RawRecord, loaded: LoadedPilot): RawRecord {
  const out: RawRecord = { ...record };
  for (const field of loaded.pilot.schema.fields) {
    const value = out[field.name];
    if (value === null || value === undefined) continue;
    switch (field.type) {
      case "url":
        out[field.name] = toAbsoluteUrl(String(value), loaded.pilot.target.url);
        break;
      case "number":
        out[field.name] = toNumber(value);
        break;
      case "boolean":
        out[field.name] = toBoolean(value);
        break;
      default:
        break;
    }
  }
  return out;
}

function toAbsoluteUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

/**
 * `"$1,299.50"` → `1299.5`. Sites wrap numbers in currency symbols, thousands
 * separators and units, and the number is the part that was declared.
 */
function toNumber(value: RawValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  const digits = String(value).replace(/[^\d.\-]/g, "");
  // Guard against the debris a strip can leave: "1.2.3", "-", "".
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: RawValue): boolean | null {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return null;
}
