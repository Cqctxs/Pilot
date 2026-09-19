/**
 * The single entry point for running a compiled Pilot.
 *
 * Nothing reachable from here calls a model. Once a Pilot exists, searching is
 * ordinary deterministic code — that is the whole point of compiling.
 */
import type { LoadedPilot } from "../pilots/store.js";
import type { RawRecord } from "../shared/schema.js";
import { runScript, type ScriptQuery } from "./script.js";

export interface ExecuteOptions {
  query?: Partial<ScriptQuery>;
  timeoutMs?: number;
  onLog?: (message: string) => void;
}

export async function executePilot(
  loaded: LoadedPilot,
  options: ExecuteOptions = {},
): Promise<RawRecord[]> {
  const query: ScriptQuery = {
    keywords: "",
    location: "",
    limit: null,
    ...loaded.config.variables,
    ...options.query,
  };

  const records = await runScript(loaded.pilot, loaded.dir, query, {
    timeoutMs: options.timeoutMs,
    onLog: options.onLog,
  });

  return records.map((record) => coerce(record, loaded));
}

/** Resolve relative URLs against the target so callers always get a clickable link. */
function coerce(record: RawRecord, loaded: LoadedPilot): RawRecord {
  const out: RawRecord = { ...record };
  for (const field of loaded.pilot.schema.fields) {
    const value = out[field.name];
    if (field.type === "url" && value) {
      try {
        out[field.name] = new URL(value, loaded.pilot.target.url).toString();
      } catch {
        out[field.name] = value;
      }
    }
  }
  return out;
}
