/**
 * A script is only accepted if it actually pulls data off the live site.
 *
 * This is the gate that separates a compiler from a code generator: the model's
 * output is a candidate, and this decides whether it becomes a Pilot. Nothing
 * writes a Pilot except through here.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DataSchema, RawRecord } from "../shared/schema.js";
import type { Pilot } from "../shared/pilot.js";
import { runScript, type ScriptQuery } from "../runtime/script.js";
import { toPilotError } from "../shared/errors.js";

export interface ValidationReport {
  ok: boolean;
  records: RawRecord[];
  /** Human-readable reasons, fed straight back to the model on a retry. */
  problems: string[];
  /** Which query keys the script was shown to read. */
  probe: ProbeOutcome;
}

/** A report for a candidate that never got far enough to be asked twice. */
const NOT_PROBED = { ran: false, readKeys: [], unreadKeys: [] };

/** Required fields must be present on essentially every record, not just most. */
const REQUIRED_FIELD_COVERAGE = 0.9;

/** Static checks worth running before spending a browser launch on the script. */
const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, message: "uses require(); the script must be a self-contained ES module" },
  { pattern: /\bimport\s+[^(]/, message: "has import statements; the script must be self-contained" },
  { pattern: /\bwhile\s*\(\s*true\s*\)/, message: "contains a `while (true)` loop" },
  { pattern: /\bprocess\s*\./, message: "touches `process`" },
  { pattern: /node:|child_process|\bfs\b/, message: "references Node built-ins" },
];

/** Any way a script could legitimately reach the site. */
const CONTACTS_SITE = /page\s*\.\s*goto\s*\(|\bfetch\s*\(|page\s*\.\s*request\b/;

export function checkScriptSource(code: string): string[] {
  const problems: string[] = [];
  if (!/export\s+(async\s+)?function\s+search\s*\(/.test(code)) {
    problems.push("does not export `async function search(page, query)`");
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(code)) problems.push(`Script ${rule.message}.`);
  }
  // A script that never contacts the site cannot be extracting anything from
  // it. Observed for real: told that a site was behind Cloudflare, the model
  // pasted the listings it had seen while exploring into an array literal and
  // submitted that. It satisfied every shape check, because the shape was
  // right — it was the provenance that was fake.
  if (!CONTACTS_SITE.test(code)) {
    problems.push(
      "Script never contacts the site — no page.goto, fetch or page.request. " +
        "Records must be read from the live page, never written into the script.",
    );
  }
  return problems;
}

/**
 * Run a candidate script from a scratch directory. It never touches `pilots/`
 * unless it passes — a rejected candidate leaves no trace.
 */
export async function validateScript(input: {
  code: string;
  needsBrowser: boolean;
  schema: DataSchema;
  pilotId: string;
  targetUrl: string;
  query: ScriptQuery;
  /** Re-run with a different query to prove the script reads it. Default true. */
  probe?: boolean;
  /** Secrets are inputs, but must never be mutated, logged or included in probe evidence. */
  sensitiveQueryKeys?: readonly string[];
  timeoutMs?: number;
  onLog?: (message: string) => void;
}): Promise<ValidationReport> {
  const staticProblems = checkScriptSource(input.code);
  if (staticProblems.length > 0) {
    return { ok: false, records: [], problems: staticProblems, probe: NOT_PROBED };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pilot-validate-"));
  const sensitiveValues = (input.sensitiveQueryKeys ?? [])
    .map((key) => input.query[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  try {
    writeFileSync(path.join(dir, "extract.mjs"), input.code);

    const candidate: Pilot = {
      pilotFormatVersion: 2,
      id: input.pilotId,
      version: "0.0.1",
      target: { name: input.pilotId, url: input.targetUrl },
      capability: null,
      capabilitySchemaVersion: null,
      schema: input.schema,
      schemaExtensions: [],
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: input.needsBrowser },
      discovered: [],
      origin: "ai-generated",
      createdAt: new Date().toISOString(),
      compiler: null,
      evidence: { recordCount: 0, checkedAt: new Date().toISOString(), sampleFile: null, probe: NOT_PROBED },
    };

    let records: RawRecord[];
    try {
      records = await runScript(candidate, dir, input.query, {
        timeoutMs: input.timeoutMs,
        onLog: input.onLog,
        sensitiveValues,
      });
    } catch (cause) {
      const error = toPilotError(cause);
      return { ok: false, records: [], problems: [`${error.code}: ${error.message}`], probe: NOT_PROBED };
    }

    const report: ValidationReport = {
      ...judge(records, input.schema, input.code),
      records,
      probe: { ran: false, readKeys: [], unreadKeys: [] },
    };
    if (!report.ok || input.probe === false) return report;

    // Everything above proves the script reads the site. Nothing above proves
    // it reads the *query*, so ask again — one key at a time.
    const outcome = await probeEachKey({
      candidate,
      dir,
      query: input.query,
      excludedKeys: input.sensitiveQueryKeys,
      first: records,
      timeoutMs: input.timeoutMs,
      onLog: input.onLog,
    });
    report.probe = outcome;
    if (outcome.unreadKeys.length > 0) {
      report.ok = false;
      report.problems.push(describeUnread(outcome.unreadKeys, input.query));
    }
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the probe learned. Recorded on the Pilot, not just used and discarded. */
export interface ProbeOutcome {
  /** False when the probe could not run at all — no keys, or every run failed. */
  ran: boolean;
  /** Keys the script demonstrably reads: changing them changed the answer. */
  readKeys: string[];
  /** Keys it demonstrably ignores. Any entry here fails the compile. */
  unreadKeys: string[];
  /** Keys whose probe run threw, so nothing was learned about them. */
  skippedKeys?: string[];
}

/**
 * Values chosen to be real but unrelated, so a site that honours the query
 * answers differently and a site that ignores it cannot accidentally match.
 */
const PROBE_VALUES: Record<string, string> = {
  keywords: "veterinary nurse",
  location: "Reykjavik",
  origin: "OSL",
  destination: "AKL",
  departureAirport: "OSL",
  arrivalAirport: "AKL",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sites throttle back-to-back requests; a 429 teaches the probe nothing. */
const PROBE_SPACING_MS = 4_000;

/** At most this many probe runs, so a wide query cannot make a compile crawl. */
const MAX_PROBES = 4;

/**
 * A different value of the same kind.
 *
 * Kind matters: a date replaced with nonsense makes the site reject the request,
 * and a request that errors proves nothing about whether the script read it. A
 * date five weeks later is still a date, so the site answers, and a script that
 * ignored it answers identically.
 */
export function varyValue(key: string, value: string): string {
  if (ISO_DATE.test(value)) {
    const shifted = new Date(`${value}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + 35);
    return shifted.toISOString().slice(0, 10);
  }
  return PROBE_VALUES[key] ?? `${value.split("").reverse().join("")}x`;
}

/**
 * The keys worth probing, in the order they are most often hardcoded.
 *
 * Dates first. A script that reads the route but inlines the date is the
 * common metasearch failure, and it is invisible to a probe that varies
 * everything at once: the route change alone makes the output differ, the
 * check passes, and every flight it ever returns is dated wrong.
 *
 * When nothing carries a value, blank keys are filled in instead. A compile
 * validates with an empty query — asking a job board for everything is the one
 * question every board answers — so a check that could only vary keys already
 * carrying a value had nothing to vary and never ran. Every Pilot compiled
 * that way recorded `probe.ran: false`, which is honest and useless: the
 * machinery existed and measured nothing. Going from "" to a real value is the
 * same experiment run the other way round, and a script that ignores the query
 * answers identically either way.
 *
 * Only as a fallback, though. Every query carries `keywords` and `location`
 * whether or not the capability means anything by them, so filling them in
 * alongside a flights query that already has airports and a date would fail a
 * correct flights Pilot for ignoring a key it is right to ignore. A query that
 * already says something is probed on what it says.
 */
export function probeKeys(query: ScriptQuery, excludedKeys: readonly string[] = []): string[] {
  const excluded = new Set(excludedKeys);
  const text = Object.entries(query).filter(
    ([key, value]) => !excluded.has(key) && typeof value === "string",
  );
  const isDate = (key: string) => ISO_DATE.test(String(query[key]));
  const filled = text.filter(([, value]) => (value as string).trim() !== "").map(([key]) => key);
  if (filled.length > 0) {
    return [...filled.filter(isDate), ...filled.filter((key) => !isDate(key))].slice(0, MAX_PROBES);
  }
  // Only keys with a known-good stand-in: filling `limit` or an unknown key
  // with invented text asks the site a question it may simply reject, and a
  // rejected request proves nothing about what the script read.
  return text
    .filter(([key, value]) => (value as string).trim() === "" && key in PROBE_VALUES)
    .map(([key]) => key)
    .slice(0, MAX_PROBES);
}

/** One key changed, everything else exactly as the script was given it. */
export function probeQuery(query: ScriptQuery, key: string): ScriptQuery {
  return { ...query, [key]: varyValue(key, String(query[key])) };
}

/**
 * Ask the script the same question with one detail changed, for each detail.
 *
 * Varying every key at once only proves the script read *something*. A flights
 * script that builds its route from the query but writes the date in as a
 * literal answers differently when the route changes, so it passes — and then
 * dates every flight it ever returns with the day it was compiled. One key at a
 * time is the only version of this check that names which key is wrong.
 */
async function probeEachKey(input: {
  candidate: Pilot;
  dir: string;
  query: ScriptQuery;
  first: RawRecord[];
  excludedKeys?: readonly string[];
  timeoutMs?: number;
  onLog?: (message: string) => void;
}): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = { ran: false, readKeys: [], unreadKeys: [] };
  if (input.first.length === 0) return outcome;

  const skipped: string[] = [];
  for (const key of probeKeys(input.query, input.excludedKeys)) {
    const probe = probeQuery(input.query, key);
    input.onLog?.(`probing ${key}: ${JSON.stringify(input.query[key])} → ${JSON.stringify(probe[key])}`);
    // Spaced, because the sites most worth checking are the ones that throttle.
    // Probing immediately after the first run is how you get a 429 instead of
    // an answer, on exactly the Pilots that need the answer most.
    await new Promise((resolve) => setTimeout(resolve, PROBE_SPACING_MS));
    try {
      const again = await runScript(input.candidate, input.dir, probe, {
        timeoutMs: input.timeoutMs,
        onLog: input.onLog,
        sensitiveValues: (input.excludedKeys ?? [])
          .map((excluded) => input.query[excluded])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      });
      outcome.ran = true;
      // Different answer — or no answer, which means the site was asked and had
      // nothing for the new value. Either way the key reached the site.
      if (again.length === 0 || fingerprint(input.first) !== fingerprint(again)) {
        outcome.readKeys.push(key);
      } else {
        outcome.unreadKeys.push(key);
      }
    } catch {
      // Nothing learned about this key: a site may reject an unfamiliar value,
      // or throttle. Recorded rather than silently forgotten, so a Pilot that
      // was never actually checked is distinguishable from one that passed.
      skipped.push(key);
    }
  }
  if (skipped.length > 0) outcome.skippedKeys = skipped;
  return outcome;
}

function describeUnread(unread: string[], query: ScriptQuery): string {
  return (
    `The script ignores ${unread.length === 1 ? "one input" : "these inputs"}: ` +
    // Both ends of the experiment, so the reader can repeat it by hand rather
    // than guess what "ignores keywords" was measured against.
    `${unread
      .map(
        (key) =>
          `${key} (${JSON.stringify(query[key])} → ` +
          `${JSON.stringify(varyValue(key, String(query[key])))})`,
      )
      .join(", ")}. ` +
    `Changing ${unread.length === 1 ? "it" : "them"} produced byte-identical records, ` +
    `which means the value is written into the script — into the URL, a form fill, ` +
    `or a selector — rather than read from the \`query\` argument. Build every part ` +
    `of the request from \`query\`, so a different question gives a different answer.`
  );
}

function fingerprint(records: RawRecord[]): string {
  return JSON.stringify(records.map((record) => Object.entries(record).sort()));
}

/**
 * Does the *data* live in the script?
 *
 * A real script names each field once or twice, where it maps the page onto the
 * schema. A script with the records baked in names them once per record, so the
 * count scales with the result set instead of staying constant. Measured on the
 * four Pilots compiled so far: at most 3 occurrences regardless of whether the
 * script returned 4 records or 59. A fabricated one matched its record count
 * exactly.
 *
 * The `> 4` floor keeps a small genuine result set from tripping it.
 */
function looksFabricated(code: string, records: RawRecord[], schema: DataSchema): string | null {
  for (const field of schema.fields.filter((item) => item.required)) {
    const asKey = new RegExp(`["']?\\b${field.name}\\b["']?\\s*:`, "g");
    const count = (code.match(asKey) ?? []).length;
    if (count > 4 && count >= records.length) {
      return (
        `Script contains "${field.name}" as a literal key ${count} times for ${records.length} records. ` +
        "The records are written into the script rather than read from the site. " +
        "If the site cannot be reached, throw an error saying so — never return invented data."
      );
    }
  }
  return null;
}

/**
 * Everything the gate decides once a script has actually run. Exported so the
 * decision can be tested directly against records, without paying for a model
 * or a browser to produce them.
 */
export function judge(
  records: RawRecord[],
  schema: DataSchema,
  code: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (records.length === 0) {
    problems.push(
      "The script ran but returned zero records. Either the selector matched nothing or the results had not loaded when it read the page.",
    );
    return { ok: false, problems };
  }

  for (const field of schema.fields) {
    const present = records.filter((record) => record[field.name]).length;
    const coverage = present / records.length;
    if (field.required && coverage < REQUIRED_FIELD_COVERAGE) {
      problems.push(
        `Required field "${field.name}" is present on only ${present}/${records.length} records. Its selector is wrong.`,
      );
    } else if (!field.required && present === 0) {
      problems.push(
        `Optional field "${field.name}" is null on every record. If the site does show it, fix the selector; if it genuinely does not, that is fine.`,
      );
    }
    if (field.type === "url") {
      const bad = records.find((record) => record[field.name] && !isUrlish(String(record[field.name])));
      if (bad) {
        problems.push(`Field "${field.name}" is not a URL: ${JSON.stringify(bad[field.name])}`);
      }
    } else if (field.type === "number") {
      const bad = records.find(
        (record) => record[field.name] && !Number.isFinite(Number(record[field.name])),
      );
      if (bad) {
        problems.push(`Field "${field.name}" is not a number: ${JSON.stringify(bad[field.name])}`);
      }
    } else if (field.type === "boolean") {
      const bad = records.find(
        (record) => record[field.name] && !/^(true|false|yes|no|1|0)$/i.test(String(record[field.name])),
      );
      if (bad) {
        problems.push(`Field "${field.name}" is not a boolean: ${JSON.stringify(bad[field.name])}`);
      }
    }
  }

  // Every record identical almost always means the row selector matched one
  // container rather than the repeating element.
  if (records.length > 1) {
    const first = JSON.stringify(records[0]);
    if (records.every((record) => JSON.stringify(record) === first)) {
      problems.push(
        "Every record is identical. The row selector is matching a single container instead of the repeating element.",
      );
    }
  }

  // A blocked page often yields a handful of junk rows rather than an error.
  //
  // Only meaningful when the schema has required fields: `[].every()` is true,
  // so without this guard a schema of all-optional fields marks every record
  // empty and can never validate — which is exactly what a freshly proposed
  // capability looks like, since proposals arrive optional by default.
  const requiredNames = schema.fields.filter((field) => field.required).map((field) => field.name);
  if (requiredNames.length > 0) {
    const emptyish = records.filter((record) =>
      requiredNames.every((name) => !record[name]),
    ).length;
    if (emptyish > records.length / 2) {
      problems.push(
        `More than half the records (${emptyish}/${records.length}) have no value for any ` +
          `required field (${requiredNames.join(", ")}). The extraction is matching the wrong elements.`,
      );
    }
  }

  const fabricated = looksFabricated(code, records, schema);
  if (fabricated) problems.push(fabricated);

  // Optional-field-only complaints are advisory; they should not block a Pilot
  // that otherwise works.
  const blocking = problems.filter((problem) => !problem.startsWith('Optional field'));
  return { ok: blocking.length === 0, problems };
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
