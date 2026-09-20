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
}

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
  timeoutMs?: number;
  onLog?: (message: string) => void;
}): Promise<ValidationReport> {
  const staticProblems = checkScriptSource(input.code);
  if (staticProblems.length > 0) {
    return { ok: false, records: [], problems: staticProblems };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pilot-validate-"));
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
      evidence: { recordCount: 0, checkedAt: new Date().toISOString(), sampleFile: null },
    };

    let records: RawRecord[];
    try {
      records = await runScript(candidate, dir, input.query, {
        timeoutMs: input.timeoutMs,
        onLog: input.onLog,
      });
    } catch (cause) {
      const error = toPilotError(cause);
      return { ok: false, records: [], problems: [`${error.code}: ${error.message}`] };
    }

    const report = { ...judge(records, input.schema, input.code), records };
    if (!report.ok || input.probe === false) return report;

    // Everything above proves the script reads the site. Nothing above proves
    // it reads the *query* — so ask it a second, different question.
    const probe = probeQuery(input.query);
    if (!probe) return report;
    try {
      const again = await runScript(candidate, dir, probe, {
        timeoutMs: input.timeoutMs,
        onLog: input.onLog,
      });
      const problem = judgeProbe(records, again, input.query, probe);
      if (problem) {
        report.ok = false;
        report.problems.push(problem);
      }
    } catch {
      // A probe that throws says nothing either way — a site may reject an
      // unfamiliar query, and failing the compile for that would be worse than
      // the gap this check closes.
    }
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A different question, built from the one the compiler was given.
 *
 * Returns null when there is nothing to vary — an empty query cannot be
 * perturbed, and a script for a site with no search is legitimately constant.
 */
export function probeQuery(query: ScriptQuery): ScriptQuery | null {
  const changed: ScriptQuery = { ...query };
  let varied = false;
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    // Deliberately unrelated to the original. A near-miss ("intern" →
    // "interns") can legitimately return the same page of results; something
    // entirely different cannot, unless the query was never used.
    changed[key as keyof ScriptQuery] = varyValue(key, value);
    varied = true;
  }
  return varied ? changed : null;
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
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A different value of the same kind.
 *
 * Kind matters: a date replaced with nonsense makes the site reject the request,
 * and a request that errors proves nothing about whether the script read it. A
 * date five weeks later is still a date, so the site answers, and a script that
 * ignored it answers identically.
 */
function varyValue(key: string, value: string): string {
  if (ISO_DATE.test(value)) {
    const shifted = new Date(`${value}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + 35);
    return shifted.toISOString().slice(0, 10);
  }
  return PROBE_VALUES[key] ?? `${value.split("").reverse().join("")}x`;
}

/**
 * Did the script actually use its query?
 *
 * The failure this catches: a compiler that inlines the sample values it was
 * given — a flights script with `YTO-YVR/2026-10-20` baked into the URL — then
 * passes validation because validation re-runs the very query it hardcoded.
 * Twenty real records come back, every field populated, and the Pilot returns
 * Toronto→Vancouver for every question anyone ever asks it. Confidently wrong,
 * and nothing downstream can tell.
 *
 * Identical output for an unrelated query is the signature. Zero records for
 * the probe is a *pass*: it means the site was asked and had nothing.
 */
export function judgeProbe(
  first: RawRecord[],
  second: RawRecord[],
  query: ScriptQuery,
  probe: ScriptQuery,
): string | null {
  if (first.length === 0) return null;
  if (fingerprint(first) !== fingerprint(second)) return null;
  const varied = Object.keys(probe).filter(
    (key) => probe[key as keyof ScriptQuery] !== query[key as keyof ScriptQuery],
  );
  return (
    `The script returned identical records for two different queries ` +
    `(${varied.map((key) => `${key}: ${JSON.stringify(query[key as keyof ScriptQuery])} → ${JSON.stringify(probe[key as keyof ScriptQuery])}`).join(", ")}). ` +
    `It is not reading the query — most likely the sample values are written into ` +
    `the URL or the selectors. Build the request from the \`query\` argument so a ` +
    `different question gives a different answer.`
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
