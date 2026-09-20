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
      schema: input.schema,
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

    return { ...judge(records, input.schema, input.code), records };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function judge(
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
      const bad = records.find((record) => record[field.name] && !isUrlish(record[field.name]!));
      if (bad) {
        problems.push(`Field "${field.name}" is not a URL: ${JSON.stringify(bad[field.name])}`);
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
  const requiredNames = schema.fields.filter((field) => field.required).map((field) => field.name);
  const emptyish = records.filter((record) =>
    requiredNames.every((name) => !record[name]),
  ).length;
  if (emptyish > records.length / 2) {
    problems.push("More than half the records are empty. The extraction is matching the wrong elements.");
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
