/**
 * End-to-end through the deterministic path: a hand-written recipe against the
 * local board. No model, no network beyond localhost.
 *
 * This is the contract the compiler has to satisfy — whatever it generates must
 * behave like the recipe below.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBoard } from "../../src/testboard/server.js";
import { executePilot } from "../../src/runtime/execute.js";
import { JOBS_CAPABILITY, JOBS_SCHEMA, filterJobs, toJob, type Job } from "../../src/capability/jobs.js";
import { parsePilot, type Pilot } from "../../src/shared/pilot.js";

const PORT = 4137;
const BASE = `http://127.0.0.1:${PORT}`;
let server: Server;

function buildPilot(): Pilot {
  return parsePilot({
    pilotFormatVersion: 1,
    id: "testboard",
    version: "1.0.0",
    target: { name: "Test Board", url: BASE },
    capability: JOBS_CAPABILITY,
    schema: JOBS_SCHEMA,
    recipe: {
      recipeFormatVersion: 1,
      kind: "http-json",
      request: { urlTemplate: `${BASE}/api/jobs?q={keywords}&loc={location}` },
      recordsPath: "results",
      fields: {
        title: { sources: [{ path: "title" }], allowMissing: false },
        company: { sources: [{ path: "company" }], allowMissing: false },
        location: { sources: [{ path: "location" }], allowMissing: true },
        url: { sources: [{ path: "url" }], allowMissing: false },
        employmentType: { sources: [{ path: "employmentType" }], allowMissing: true },
        postedAt: { sources: [{ path: "postedAt" }], allowMissing: true },
      },
    },
    origin: "handwritten",
    createdAt: new Date().toISOString(),
    evidence: { recordCount: 8, checkedAt: new Date().toISOString() },
  });
}

async function search(query: { keywords?: string; location?: string }): Promise<Job[]> {
  const records = await executePilot(buildPilot(), {
    variables: { keywords: query.keywords ?? "", location: query.location ?? "" },
  });
  const jobs = records
    .map((record) => toJob("testboard", record))
    .filter((job): job is Job => job !== null);
  return filterJobs(jobs, query);
}

beforeAll(async () => {
  server = await startTestBoard({ port: PORT, layout: "a" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("runtime against the test board", () => {
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
});
