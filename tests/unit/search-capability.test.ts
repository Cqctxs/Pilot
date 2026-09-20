import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { resolveSearchCapability } from "../../src/cli/search.js";
import { JOBS_CAPABILITY } from "../../src/capability/jobs.js";
import { PilotStore } from "../../src/pilots/store.js";
import { findProjectRoot, loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { parsePilot } from "../../src/shared/pilot.js";

let root: string;
let env: PilotEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pilot-search-capability-"));
  env = {
    ...loadEnv(),
    projectRoot: root,
    pilotsDir: path.join(root, "pilots"),
    configFile: path.join(root, "config", "pilots.json"),
    lockFile: path.join(root, "pilot.lock.json"),
    capabilitiesDir: path.join(root, "config", "capabilities"),
    registryUri: null,
  };

  const fixtureDir = path.join(findProjectRoot(), "pilots", "testboard", "1.0.0");
  const fixture = parsePilot(
    JSON.parse(readFileSync(path.join(fixtureDir, "pilot.json"), "utf8")),
  );
  const code = readFileSync(path.join(fixtureDir, "extract.mjs"), "utf8");
  const store = new PilotStore(env);
  store.save({ ...fixture, id: "jobs" }, code);
  store.save(
    {
      ...fixture,
      id: "books",
      capability: "books.list@1",
      schema: {
        name: "books.list@1",
        fields: [
          { name: "title", type: "string", required: true, description: "Book title" },
          { name: "url", type: "url", required: true, description: "Book details URL" },
        ],
      },
    },
    code,
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("search capability inference", () => {
  it("infers a generic capability from an explicitly named Pilot", () => {
    expect(resolveSearchCapability(env, parseArgs(["books"]))).toBe("books.list@1");
  });

  it("keeps jobs as the default when no Pilot is named", () => {
    expect(resolveSearchCapability(env, parseArgs([]))).toBe(JOBS_CAPABILITY);
  });

  it("resolves an explicit capability override", () => {
    expect(
      resolveSearchCapability(env, parseArgs(["books", "--capability", "books.list@1"])),
    ).toBe("books.list@1");
  });

  it("refuses to combine Pilots implementing different interfaces", () => {
    expect(() => resolveSearchCapability(env, parseArgs(["books", "jobs"]))).toThrow(
      /different capabilities/,
    );
  });
});
