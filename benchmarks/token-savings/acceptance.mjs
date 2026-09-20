import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function search(...args) {
  const run = spawnSync(process.execPath, ["src/search.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      // The warm test proves the installed Pilot runs without compiler access.
      OPENAI_API_KEY: "",
      PILOT_COMPILER_MODEL: "",
    },
    timeout: 30_000,
  });

  assert.equal(
    run.status,
    0,
    `search command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );

  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    assert.fail(`stdout must contain only JSON\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  assert.ok(Array.isArray(parsed), "search output must be an array");
  return parsed;
}

function validRecord(job) {
  assert.equal(typeof job.title, "string");
  assert.equal(typeof job.company, "string");
  assert.ok(job.location === null || typeof job.location === "string");
  assert.equal(typeof job.type, "string");
  assert.match(job.url, /^http:\/\/127\.0\.0\.1:4100\/jobs\/\d+$/);
}

const internships = search(
  "--keywords",
  "software",
  "--type",
  "internship",
  "--limit",
  "5",
);
assert.equal(internships.length, 1);
assert.equal(internships[0].title, "Software Engineering Intern");
assert.equal(internships[0].type, "internship");
internships.forEach(validRecord);

const fullTime = search(
  "--keywords",
  "engineer",
  "--type",
  "full-time",
  "--limit",
  "2",
);
assert.equal(fullTime.length, 2);
assert.ok(fullTime.every((job) => job.type === "full-time"));
fullTime.forEach(validRecord);

process.stdout.write("acceptance passed\n");
