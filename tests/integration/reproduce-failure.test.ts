/**
 * Whether `pilot repair` will even look at a Pilot.
 *
 * Repair refuses to touch something that still works, which is right — swapping
 * a known-good script for an unproven one is a regression. But the check used
 * to be "did it throw", and the most common way a compiled script dies is by
 * not throwing: a selector stops matching, or a block page comes back, and the
 * extraction returns `[]`. That reads as a successful search that matched
 * nothing, so repair declined, health showed 100%, and the Pilot stayed dead.
 *
 * Real scripts against the local board, so this is the actual runtime path.
 */
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../../src/capability/jobs.js";
import { reproduceFailure } from "../../src/cli/repair.js";
import { PilotStore } from "../../src/pilots/store.js";
import { loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { startTestBoard } from "../../src/testboard/server.js";

let board: Server;
let root: string;
let env: PilotEnv;
let base: string;

/** Reads the board's JSON endpoint — the Pilot that still works. */
function workingScript(): string {
  return `export async function search(page, query) {
  const response = await fetch("${base}/api/jobs?q=" + encodeURIComponent(query.keywords || ""));
  const body = await response.json();
  return body.results.map((job) => ({
    title: job.title, company: job.company, location: job.location,
    url: job.url, employmentType: job.employmentType, postedAt: job.postedAt,
  }));
}
`;
}

/**
 * The shape this test exists for: a selector that no longer matches, swallowed,
 * returning an empty array. Lifted from the real Pilots — `catch { break }`
 * around the wait, then `if (!rows.length) break`.
 */
function silentlyEmptyScript(): string {
  return `export async function search(page, query) {
  const results = [];
  for (let p = 1; p <= 3; p++) {
    await page.goto("${base}/jobs", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForSelector("article.this-class-no-longer-exists", { timeout: 500 });
    } catch (e) {
      break;
    }
    const rows = await page.$$eval("article.this-class-no-longer-exists", (n) => n.map(() => ({})));
    if (!rows.length) break;
    results.push(...rows);
  }
  return results;
}
`;
}

/** Fails loudly, the way a repaired script should. */
function throwingScript(): string {
  return `export async function search(page, query) {
  throw new Error("Results never appeared — the site may be blocking us");
}
`;
}

function install(id: string, code: string, needsBrowser: boolean): void {
  const dir = path.join(root, "pilots", id, "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "extract.mjs"), code);
  writeFileSync(
    path.join(dir, "pilot.json"),
    JSON.stringify({
      pilotFormatVersion: 2,
      id,
      version: "1.0.0",
      target: { name: id, url: `${base}/jobs` },
      capability: JOBS_CAPABILITY,
      schema: JOBS_SCHEMA,
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser },
      discovered: [],
      origin: "handwritten",
      createdAt: new Date(0).toISOString(),
      compiler: null,
      evidence: { recordCount: 0, checkedAt: new Date(0).toISOString(), sampleFile: null },
    }),
  );
}

beforeAll(async () => {
  board = await startTestBoard({ port: 0, layout: "a" });
  const address = board.address();
  if (!address || typeof address === "string") throw new Error("Test board did not bind a port");
  base = `http://127.0.0.1:${address.port}`;

  root = mkdtempSync(path.join(tmpdir(), "pilot-reproduce-"));
  env = { ...loadEnv(), pilotsDir: path.join(root, "pilots"), configFile: path.join(root, "pilots.json") };

  install("working", workingScript(), false);
  install("hollow", silentlyEmptyScript(), true);
  install("loud", throwingScript(), true);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => board?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("reproduceFailure", () => {
  it("leaves a Pilot that returns data alone", async () => {
    const store = new PilotStore(env);
    expect(await reproduceFailure(store.get("working"), "engineer")).toBeNull();
  });

  it("treats a silently empty result as the failure, not as health", async () => {
    const store = new PilotStore(env);
    const failure = await reproduceFailure(store.get("hollow"), "engineer");

    expect(failure).not.toBeNull();
    expect(failure).toContain("zero records");
    // The repair prompt has to say what a correct replacement does differently,
    // or the next script has the same hole.
    expect(failure).toContain("throw rather than return []");
  }, 60_000);

  it("passes a thrown failure through with its code", async () => {
    const store = new PilotStore(env);
    const failure = await reproduceFailure(store.get("loud"), "engineer");
    expect(failure).toContain("PILOT_BROKEN");
    expect(failure).toContain("may be blocking us");
  }, 60_000);
});
