/**
 * Runs a compiled extraction script.
 *
 * No model is involved here and none can be: this module has no access to the
 * compiler and never reads an API key. A Pilot that has been compiled is
 * ordinary code from here on.
 *
 * Trust model, stated plainly: the script was written by a model and is
 * executed with the privileges of this process. It is reviewable code sitting
 * in `pilots/<id>/<version>/`, and it should be read before it is trusted, the
 * same as any dependency. What the runtime does enforce is a wall-clock
 * timeout, a record cap, and a shape check on whatever comes back.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pilot } from "../shared/pilot.js";
import type { RawRecord } from "../shared/schema.js";
import { pilotError } from "../shared/errors.js";

/** Handed to every script. Deliberately small — it is also the compiler's contract. */
export interface ScriptQuery {
  keywords: string;
  location: string;
  limit: number | null;
  [key: string]: string | number | null;
}

export type SearchScript = (page: unknown, query: ScriptQuery) => Promise<unknown>;

export const DEFAULT_TIMEOUT_MS = 90_000;
export const MAX_RECORDS = 500;

export interface RunScriptOptions {
  timeoutMs?: number;
  /** Surfaces `console.log` from inside a script while compiling. */
  onLog?: (message: string) => void;
}

export async function runScript(
  pilot: Pilot,
  dir: string,
  query: ScriptQuery,
  options: RunScriptOptions = {},
): Promise<RawRecord[]> {
  const entry = path.join(dir, pilot.artifact.entry);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let search: SearchScript;
  try {
    // Cache-busted so a freshly repaired script is picked up in the same process.
    const module = (await import(`${pathToFileURL(entry).href}?v=${pilot.version}`)) as {
      search?: SearchScript;
    };
    if (typeof module.search !== "function") {
      throw new Error(`${pilot.artifact.entry} does not export a "search" function`);
    }
    search = module.search;
  } catch (cause) {
    throw pilotError("PILOT_BROKEN", `Could not load ${entry}: ${(cause as Error).message}`, {
      pilotId: pilot.id,
    });
  }

  const browser = pilot.artifact.needsBrowser ? await launchBrowser() : null;
  let timer: NodeJS.Timeout | undefined;

  try {
    const page = browser ? await browser.newPage() : null;
    if (page && options.onLog) {
      page.on("console", (message: { text(): string }) => options.onLog!(`page: ${message.text()}`));
    }

    // Closing the browser is what actually stops a runaway script: every
    // subsequent page call rejects. Without a browser, the race is all we have.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void browser?.close().catch(() => undefined);
        reject(pilotError("PILOT_BROKEN", `Script exceeded ${timeoutMs}ms`, { pilotId: pilot.id }));
      }, timeoutMs);
    });

    const result = await Promise.race([search(page, query), timeout]);
    return normalizeOutput(result, pilot);
  } catch (cause) {
    if (cause && typeof cause === "object" && "error" in cause) throw cause;
    throw pilotError("PILOT_BROKEN", `Script failed: ${(cause as Error).message}`, {
      pilotId: pilot.id,
    });
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => undefined);
  }
}

interface MinimalBrowser {
  newPage(): Promise<{ on(event: string, handler: (arg: never) => void): void }>;
  close(): Promise<void>;
}

async function launchBrowser(): Promise<MinimalBrowser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  return {
    newPage: () => context.newPage() as never,
    close: () => browser.close(),
  };
}

/**
 * A script can return anything. This is where "anything" becomes the record
 * shape the rest of the system relies on — or a clear failure.
 */
function normalizeOutput(result: unknown, pilot: Pilot): RawRecord[] {
  if (!Array.isArray(result)) {
    throw pilotError(
      "PILOT_BROKEN",
      `Script returned ${result === undefined ? "nothing" : typeof result}, expected an array of records`,
      { pilotId: pilot.id },
    );
  }

  const allowed = new Set(pilot.schema.fields.map((field) => field.name));
  const records: RawRecord[] = [];

  for (const row of result.slice(0, MAX_RECORDS)) {
    if (!row || typeof row !== "object") continue;
    const record: RawRecord = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (!allowed.has(key)) continue;
      record[key] = toFieldValue(value);
    }
    if (Object.keys(record).length > 0) records.push(record);
  }

  return records;
}

function toFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(toFieldValue).filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}
