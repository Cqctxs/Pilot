/**
 * End-to-end through the deterministic path: a hand-written script Pilot
 * against the local board. No model, no external network.
 *
 * This is the contract the compiler has to satisfy — whatever the explorer
 * submits must behave like the script below.
 */
import type { Server } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBoard } from "../../src/testboard/server.js";
import { PilotStore } from "../../src/pilots/store.js";
import { executePilot } from "../../src/runtime/execute.js";
import { pilot as createPilot } from "../../src/sdk/index.js";
import {
  JOBS_CAPABILITY,
  JOBS_SCHEMA,
  filterJobs,
  toJob,
  type Job,
  type JobQuery,
} from "../../src/capability/jobs.js";
import { loadEnv } from "../../src/shared/env.js";

let server: Server;
let root: string;
let store: PilotStore;
let base: string;
let env: ReturnType<typeof loadEnv>;

/** A script exactly like one the compiler would submit for a JSON-backed site. */
function script(): string {
  return `export async function search(page, query) {
  const url = \`${base}/api/jobs?q=\${encodeURIComponent(query.keywords || "")}&loc=\${encodeURIComponent(query.location || "")}\`;
  const response = await fetch(url);
  const body = await response.json();
  const records = body.results.map((job) => ({
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    employmentType: job.employmentType,
    postedAt: job.postedAt,
    seniority: job.title.includes("Intern") ? "Entry" : "Mid",
  }));
  const limit = Number(query.limit);
  return Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;
}
`;
}

const TEST_SCHEMA = {
  ...JOBS_SCHEMA,
  fields: [
    ...JOBS_SCHEMA.fields,
    {
      name: "seniority",
      type: "string" as const,
      required: false,
      description: "Experience level shown by the board",
    },
  ],
};

function install(): void {
  const dir = path.join(root, "pilots", "testboard", "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "extract.mjs"), script());
  writeFileSync(
    path.join(dir, "pilot.json"),
    JSON.stringify({
      pilotFormatVersion: 2,
      id: "testboard",
      version: "1.0.0",
      target: { name: "Test Board", url: base },
      capability: JOBS_CAPABILITY,
      schema: TEST_SCHEMA,
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
      discovered: [],
      origin: "handwritten",
      createdAt: new Date().toISOString(),
      evidence: { recordCount: 8, checkedAt: new Date().toISOString() },
    }),
  );
}

async function search(query: JobQuery): Promise<Job[]> {
  const loaded = store.get("testboard");
  const records = await executePilot(loaded, {
    query: { keywords: query.keywords ?? "", location: query.location ?? "" },
  });
  const jobs = records
    .map((record) => toJob("testboard", record, loaded.pilot.schema))
    .filter((job): job is Job => job !== null);
  return filterJobs(jobs, query);
}

beforeAll(async () => {
  server = await startTestBoard({ port: 0, layout: "a" });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test board did not bind a TCP port");
  base = `http://127.0.0.1:${address.port}`;
  root = mkdtempSync(path.join(tmpdir(), "pilot-test-"));
  install();
  env = {
    ...loadEnv(),
    pilotsDir: path.join(root, "pilots"),
    configFile: path.join(root, "pilots.json"),
    capabilitiesDir: path.join(root, "capabilities"),
  };
  store = new PilotStore(env);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("running a script Pilot against the test board", () => {
  it("returns the complete catalogue for an empty query", async () => {
    expect(await search({})).toHaveLength(8);
  });

  it("narrows by keyword", async () => {
    const jobs = await search({ keywords: "intern" });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.title.toLowerCase().includes("intern"))).toBe(true);
  });

  it("narrows by location", async () => {
    const jobs = await search({ location: "Boston" });
    expect(jobs.every((job) => job.location?.includes("Boston"))).toBe(true);
  });

  it("returns an empty list for a true no-match rather than failing", async () => {
    expect(await search({ keywords: "underwater basket weaving" })).toEqual([]);
  });

  it("keeps a posting whose location is missing", async () => {
    const jobs = await search({ keywords: "machine learning" });
    expect(jobs[0]?.location).toBeNull();
  });

  it("classifies a type the board never labelled, from the title", async () => {
    const jobs = await search({ keywords: "machine learning" });
    expect(jobs[0]?.type).toBe("internship");
    expect(jobs[0]?.typeBasis).toBe("title");
  });

  it("resolves every url to something absolute", async () => {
    const jobs = await search({});
    expect(jobs.every((job) => job.url.startsWith("http"))).toBe(true);
  });

  it("preserves and filters a compiler-added field", async () => {
    const all = await search({});
    expect(all[0]?.attributes.seniority).toBe("Entry");

    const mid = await search({ filters: { seniority: "Mid" } });
    expect(mid).toHaveLength(4);
    expect(mid.every((job) => job.attributes.seniority === "Mid")).toBe(true);
  });

  it("applies limit after local employment-type filtering", async () => {
    const jobs = createPilot(env).capability(JOBS_CAPABILITY);
    const result = await jobs.search("testboard", {
      keywords: "engineer",
      type: "full-time",
      limit: 2,
    });

    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every((job) => job.type === "full-time")).toBe(true);
  });
});
