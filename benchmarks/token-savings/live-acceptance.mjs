import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const expectedSources = ["linkedin", "ziprecruiter", "talent"];
const run = spawnSync(
  process.execPath,
  [
    "src/search.mjs",
    "--keywords",
    "software engineer",
    "--location",
    "Boston",
    "--limit",
    "2",
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      // A warm Pilot must run without invoking the compiler model.
      OPENAI_API_KEY: "",
      PILOT_COMPILER_MODEL: "",
    },
    timeout: 120_000,
  },
);

assert.equal(
  run.status,
  0,
  `search command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
);

let output;
try {
  output = JSON.parse(run.stdout);
} catch {
  assert.fail(`stdout must contain only JSON\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
}

assert.ok(output && typeof output === "object", "output must be an object");
assert.ok(Array.isArray(output.jobs), "output.jobs must be an array");
assert.ok(Array.isArray(output.sources), "output.sources must be an array");

const statuses = new Map(
  output.sources.map((source) => [source.source ?? source.pilotId, source]),
);
assert.deepEqual(
  [...statuses.keys()].sort(),
  [...expectedSources].sort(),
  "sources must report linkedin, ziprecruiter, and talent",
);
assert.ok(
  [...statuses.values()].some((source) => source.ok === true),
  "at least one live source must succeed",
);
assert.ok(output.jobs.length > 0, "at least one live job must be returned");

for (const job of output.jobs) {
  assert.ok(expectedSources.includes(job.source), `unexpected source: ${job.source}`);
  assert.equal(typeof job.title, "string");
  assert.equal(typeof job.company, "string");
  assert.ok(job.location === null || typeof job.location === "string");
  assert.equal(typeof job.type, "string");
  assert.match(job.url, /^https?:\/\//);
}

process.stdout.write(
  `acceptance passed: ${output.jobs.length} jobs, ` +
    `${[...statuses.values()].filter((source) => source.ok).length}/3 sources live\n`,
);
