/**
 * Prompt A/B lab.
 *
 * Compiles the same site N times under each system prompt and scores the
 * scripts that come out. The target is the local board in hostile mode, so the
 * page is identical for every run and no live site is touched: any difference
 * between the two columns is the prompt.
 *
 * Scored on what the prompts actually disagree about — waiting correctly,
 * failing loudly, never inventing data — plus what every compile costs in steps
 * and attempts.
 *
 *   npm run promptlab -- --runs 3
 */
import { compile } from "../compiler/index.js";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../capability/jobs.js";
import { startTestBoard } from "../testboard/server.js";
import { loadEnv } from "../shared/env.js";
import { toPilotError } from "../shared/errors.js";
import type { PromptStyle } from "../compiler/prompts.js";

interface RunResult {
  style: PromptStyle;
  ok: boolean;
  error: string | null;
  steps: number;
  attempts: number;
  records: number;
  seconds: number;
  /** Behaviours the prompts disagree about, read off the emitted script. */
  usesNetworkidle: boolean;
  throwsOnFailure: boolean;
  fabricates: boolean;
  needsBrowser: boolean;
}

const PORT = 4171;

function scoreScript(code: string): Pick<RunResult, "usesNetworkidle" | "throwsOnFailure" | "fabricates"> {
  return {
    usesNetworkidle: /networkidle/.test(code),
    throwsOnFailure: /throw\s+new\s+Error/.test(code),
    // Records written into the source rather than read from the page.
    fabricates: !/page\s*\.\s*goto\s*\(|\bfetch\s*\(/.test(code) || (code.match(/["']?\btitle\b["']?\s*:/g) ?? []).length > 4,
  };
}

async function runOnce(style: PromptStyle, index: number): Promise<RunResult> {
  const started = Date.now();
  const base: RunResult = {
    style,
    ok: false,
    error: null,
    steps: 0,
    attempts: 0,
    records: 0,
    seconds: 0,
    usesNetworkidle: false,
    throwsOnFailure: false,
    fabricates: false,
    needsBrowser: false,
  };

  try {
    const result = await compile({
      url: `http://127.0.0.1:${PORT}/jobs`,
      id: `lab-${style}-${index}`,
      name: "Test Board",
      capability: JOBS_CAPABILITY,
      schema: JOBS_SCHEMA,
      query: { keywords: "engineer", location: "" },
      promptStyle: style,
      headless: true,
      env: loadEnv(),
    });
    return {
      ...base,
      ok: true,
      steps: result.steps,
      attempts: result.attempts,
      records: result.records.length,
      seconds: (Date.now() - started) / 1000,
      needsBrowser: result.pilot.artifact.needsBrowser,
      ...scoreScript(result.code),
    };
  } catch (cause) {
    const error = toPilotError(cause);
    return { ...base, error: `${error.code}`, seconds: (Date.now() - started) / 1000 };
  }
}

function summarize(rows: RunResult[]): string {
  const n = rows.length;
  if (n === 0) return "no runs";
  const ok = rows.filter((row) => row.ok);
  const mean = (pick: (row: RunResult) => number, from = ok) =>
    from.length === 0 ? 0 : from.reduce((sum, row) => sum + pick(row), 0) / from.length;
  const count = (pick: (row: RunResult) => boolean) => ok.filter(pick).length;

  return [
    `compiled            ${ok.length}/${n}`,
    `mean steps          ${mean((row) => row.steps).toFixed(1)}`,
    `mean attempts       ${mean((row) => row.attempts).toFixed(2)}`,
    `mean seconds        ${mean((row) => row.seconds).toFixed(1)}`,
    `mean records        ${mean((row) => row.records).toFixed(1)}`,
    `used networkidle    ${count((row) => row.usesNetworkidle)}/${ok.length}   (lower is better)`,
    `throws on failure   ${count((row) => row.throwsOnFailure)}/${ok.length}   (higher is better)`,
    `fabricated data     ${count((row) => row.fabricates)}/${ok.length}   (lower is better)`,
    `chose http          ${count((row) => !row.needsBrowser)}/${ok.length}`,
  ].join("\n  ");
}

export async function runPromptLab(runs: number): Promise<number> {
  const board = await startTestBoard({ port: PORT, layout: "a", hostile: true });
  const results: RunResult[] = [];

  try {
    // Interleaved rather than grouped, so drift in the model or the machine
    // hits both columns equally.
    for (let i = 0; i < runs; i += 1) {
      for (const style of ["strict", "guided"] as PromptStyle[]) {
        process.stdout.write(`run ${i + 1}/${runs} ${style.padEnd(7)} `);
        const result = await runOnce(style, i);
        results.push(result);
        process.stdout.write(
          result.ok
            ? `ok  ${result.steps} steps, ${result.attempts} attempt(s), ${result.records} records, ${result.seconds.toFixed(0)}s` +
                `${result.usesNetworkidle ? "  [networkidle]" : ""}${result.fabricates ? "  [FABRICATED]" : ""}\n`
            : `FAILED ${result.error} after ${result.seconds.toFixed(0)}s\n`,
        );
      }
    }
  } finally {
    await new Promise<void>((resolve) => board.close(() => resolve()));
  }

  for (const style of ["strict", "guided"] as PromptStyle[]) {
    process.stdout.write(`\n${style.toUpperCase()}\n  ${summarize(results.filter((row) => row.style === style))}\n`);
  }

  process.stdout.write(`\n${JSON.stringify(results)}\n`);
  return 0;
}
