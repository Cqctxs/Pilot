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

  it("infers from enabled Pilots when they all implement one capability", () => {
    const store = new PilotStore(env);
    store.setEnabled("books", false);
    expect(resolveSearchCapability(env, parseArgs([]))).toBe(JOBS_CAPABILITY);
  });

  it("errors when no Pilot is enabled", () => {
    const store = new PilotStore(env);
    store.setEnabled("books", false);
    store.setEnabled("jobs", false);
    expect(() => resolveSearchCapability(env, parseArgs([]))).toThrow(/No enabled Pilots/);
  });

  it("requires a choice when enabled Pilots span capabilities", () => {
    expect(() => resolveSearchCapability(env, parseArgs([]))).toThrow(/enabled.*different capabilities/);
  });

  it("resolves an explicit capability override", () => {
    expect(
      resolveSearchCapability(env, parseArgs(["books", "--capability", "books.list@1"])),
    ).toBe("books.list@1");
  });

  /**
   * The reported failure: `--capability jobs` answered "No enabled Pilots
   * implement jobs@1". Nothing has ever been called jobs@1 — resolution
   * invented it out of the name, so the message blamed a missing Pilot for a
   * missing `.search`. Searching must name what is here instead of minting an
   * id for what isn't.
   */
  it("refuses a capability nobody has, and points at the near miss", () => {
    expect(() => resolveSearchCapability(env, parseArgs(["--capability", "jobs"]))).toThrow(
      /No capability named "jobs" is installed/,
    );
    expect(() => resolveSearchCapability(env, parseArgs(["--capability", "jobs"]))).toThrow(
      /Did you mean:\s+jobs\.search@1/,
    );
  });

  it("names the installed capabilities when there is no near miss", () => {
    expect(() =>
      resolveSearchCapability(env, parseArgs(["--capability", "flights.search"])),
    ).toThrow(/Installed:\s+books\.list@1, jobs\.search@1/);
  });

  /**
   * A Pilot carries its own copy of the schema, so it searches fine whether or
   * not the shared definition was ever written to disk. Strictness must not
   * turn that into a failure.
   */
  it("accepts a capability known only from an installed Pilot", () => {
    expect(
      resolveSearchCapability(env, parseArgs(["--capability", "books.list"])),
    ).toBe("books.list@1");
  });

  it("refuses to combine Pilots implementing different interfaces", () => {
    expect(() => resolveSearchCapability(env, parseArgs(["books", "jobs"]))).toThrow(
      /different capabilities/,
    );
  });
});
