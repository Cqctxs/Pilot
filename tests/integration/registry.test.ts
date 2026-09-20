/**
 * The registry against a real MongoDB.
 *
 * An in-memory server rather than Atlas: the point is to exercise the actual
 * driver, indexes and aggregation pipeline, and to do it without a network or
 * a shared database that other people are publishing into.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runList } from "../../src/cli/list.js";
import { runOutdated, runUninstall, runUpdate } from "../../src/cli/packages.js";
import { runCreate } from "../../src/cli/create.js";
import { parseArgs } from "../../src/cli/args.js";
import { runInstall } from "../../src/cli/registry.js";
import { PilotLock } from "../../src/packages/lock.js";
import { PilotStore } from "../../src/pilots/store.js";
import { Registry } from "../../src/registry/client.js";
import { findProjectRoot, loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { parsePilot, type Pilot } from "../../src/shared/pilot.js";

const root = findProjectRoot();
const pilotDir = path.join(root, "pilots", "testboard", "1.0.0");

function fixture(): { pilot: Pilot; code: string } {
  return {
    pilot: parsePilot(JSON.parse(readFileSync(path.join(pilotDir, "pilot.json"), "utf8"))),
    code: readFileSync(path.join(pilotDir, "extract.mjs"), "utf8"),
  };
}

let mongo: MongoMemoryServer;
let env: PilotEnv;
let registry: Registry;
let tempRoot: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  tempRoot = mkdtempSync(path.join(tmpdir(), "pilot-packages-"));
  env = {
    ...loadEnv(),
    projectRoot: tempRoot,
    pilotsDir: path.join(tempRoot, "pilots"),
    configFile: path.join(tempRoot, "config", "pilots.json"),
    lockFile: path.join(tempRoot, "pilot.lock.json"),
    capabilitiesDir: path.join(tempRoot, "config", "capabilities"),
    registryUri: mongo.getUri(),
    registryDb: "pilot_test",
    publisher: "tester",
  };
  registry = await Registry.connect(env);
// A fresh machine may need to download the MongoDB test binary once.
}, 600_000);

afterAll(async () => {
  await registry?.close();
  await mongo?.stop();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("publishing", () => {
  it("round-trips a Pilot with its script", async () => {
    const { pilot, code } = fixture();
    await registry.publish({ pilot, code, sample: [{ title: "Engineer" }] });

    const fetched = await registry.fetch(pilot.id);
    expect(fetched.pilotId).toBe(pilot.id);
    // The script is the artifact. A registry that loses it is useless.
    expect(fetched.code).toBe(code);
    expect(fetched.publisher).toBe("tester");
    expect(fetched.pilot.schema).toEqual(pilot.schema);
  });

  it("is idempotent — republishing a version replaces it", async () => {
    const { pilot, code } = fixture();
    await registry.publish({ pilot, code });
    await registry.publish({ pilot, code: `${code}\n// edited\n` });

    expect(await registry.versions(pilot.id)).toEqual(["1.0.0"]);
    expect((await registry.fetch(pilot.id)).code).toContain("// edited");
  });

  it("lists only the newest version of each Pilot", async () => {
    const { pilot, code } = fixture();
    await registry.publish({ pilot: { ...pilot, version: "1.1.0" }, code });

    const listed = await registry.list();
    const entry = listed.find((item) => item.pilotId === pilot.id);
    expect(entry?.version).toBe("1.1.0");
    expect(listed.filter((item) => item.pilotId === pilot.id)).toHaveLength(1);
  });

  it("fetches a specific version when asked", async () => {
    expect((await registry.fetch("testboard", "1.0.0")).version).toBe("1.0.0");
    await expect(registry.fetch("testboard", "9.9.9")).rejects.toThrow(/no testboard@9.9.9/);
  });

  it("reports an unknown Pilot rather than returning nothing", async () => {
    await expect(registry.fetch("nonexistent")).rejects.toThrow(/no Pilot named/);
  });
});

describe("search", () => {
  it("finds a Pilot by id", async () => {
    const found = await registry.search("testboard");
    expect(found.map((item) => item.pilotId)).toContain("testboard");
  });

  it("finds a Pilot by the capability it implements", async () => {
    const found = await registry.search("jobs.board");
    expect(found.length).toBeGreaterThan(0);
  });

  it("returns nothing for a term no Pilot mentions", async () => {
    expect(await registry.search("zzzznotathing")).toHaveLength(0);
  });
});

describe("package listing", () => {
  it("lists published Pilots by capability through the top-level command", async () => {
    const { pilot, code } = fixture();
    await registry.publish({ pilot, code });
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await runList(env, {
        positional: [pilot.capability!],
        flags: { json: true },
      });
      expect(exitCode).toBe(0);
      const listed = JSON.parse(writes.join("")) as Array<{ pilotId: string; capability: string }>;
      expect(listed.some((entry) => entry.pilotId === pilot.id)).toBe(true);
      expect(listed.every((entry) => entry.capability === pilot.capability)).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});

describe("health", () => {
  it("aggregates a success rate and surfaces the last error", async () => {
    const version = "1.0.0";
    await registry.report({ pilotId: "flaky", version, ok: true, recordCount: 10, durationMs: 100, errorCode: null });
    await registry.report({ pilotId: "flaky", version, ok: true, recordCount: 20, durationMs: 100, errorCode: null });
    await registry.report({ pilotId: "flaky", version, ok: false, recordCount: 0, durationMs: 50, errorCode: "PILOT_BROKEN" });

    const rows = await registry.healthReport("flaky");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toBe(3);
    expect(rows[0]!.successRate).toBeCloseTo(2 / 3, 5);
    expect(rows[0]!.avgRecords).toBeCloseTo(10, 1);
    expect(rows[0]!.lastError).toBe("PILOT_BROKEN");
  });

  it("keeps showing the last error after a run that happened to succeed", async () => {
    // Otherwise an intermittently broken Pilot reads as healthy on any report
    // whose newest run was a lucky one.
    await registry.report({
      pilotId: "flaky",
      version: "1.0.0",
      ok: true,
      recordCount: 8,
      durationMs: 90,
      errorCode: null,
    });

    const rows = await registry.healthReport("flaky");
    expect(rows[0]!.successRate).toBeCloseTo(3 / 4, 5);
    expect(rows[0]!.lastError).toBe("PILOT_BROKEN");
  });

  it("sorts the worst Pilot first, so the report is a repair queue", async () => {
    await registry.report({ pilotId: "healthy", version: "1.0.0", ok: true, recordCount: 5, durationMs: 10, errorCode: null });

    const rows = await registry.healthReport();
    expect(rows[0]!.pilotId).toBe("flaky");
  });
});

describe("capabilities", () => {
  const definition = {
    capabilityFormatVersion: 1 as const,
    id: "hotels.search@1",
    version: "1.0.0",
    schema: {
      name: "hotels.search@1",
      fields: [
        { name: "name", type: "string" as const, required: true, description: "Hotel name" },
        { name: "url", type: "url" as const, required: true, description: "Hotel URL" },
      ],
    },
    coreFields: ["name", "url"],
  };

  it("round-trips a definition so two machines agree on one interface", async () => {
    const entry = await registry.publishCapability(definition);
    expect(entry._id).toBe("hotels.search@1/1.0.0");
    expect(entry.fieldNames).toEqual(["name", "url"]);

    const fetched = await registry.fetchCapability("hotels.search@1");
    expect(fetched.definition).toEqual(definition);
  });

  it("keeps every revision fetchable, and defaults to the newest", async () => {
    const promoted = {
      ...definition,
      version: "1.1.0",
      schema: {
        ...definition.schema,
        fields: [
          ...definition.schema.fields,
          { name: "stars", type: "number" as const, required: false, description: "Star rating" },
        ],
      },
    };
    await registry.publishCapability(definition);
    await registry.publishCapability(promoted);

    expect((await registry.fetchCapability("hotels.search@1")).version).toBe("1.1.0");
    // A Pilot records the revision it compiled against, so old ones must resolve.
    expect((await registry.fetchCapability("hotels.search@1", "1.0.0")).version).toBe("1.0.0");
  });

  it("publishing the same revision twice replaces it in place", async () => {
    await registry.publishCapability(definition);
    await registry.publishCapability(definition);
    const listed = await registry.listCapabilities();
    expect(listed.filter((item) => item.capabilityId === "hotels.search@1")).toHaveLength(1);
  });

  it("says so plainly when a capability is not published", async () => {
    await expect(registry.fetchCapability("nope.search@1")).rejects.toThrow(/no capability named/);
  });
});

/**
 * The failure mode a success rate cannot see.
 *
 * A script whose selector stopped matching, or that was served a block page,
 * usually returns `[]` rather than throwing — and `[]` is also a genuine
 * no-match, so the run is recorded as a success. Without counting empties, a
 * completely dead Pilot sits at 100% and never enters the repair queue.
 */
describe("health: silently empty Pilots", () => {
  it("separates succeeding-with-data from succeeding-with-nothing", async () => {
    const version = "9.0.0";
    for (let i = 0; i < 4; i += 1) {
      await registry.report({
        pilotId: "hollow",
        version,
        ok: true,
        recordCount: 0,
        durationMs: 120,
        errorCode: null,
      });
    }
    await registry.report({
      pilotId: "hollow",
      version,
      ok: true,
      recordCount: 3,
      durationMs: 120,
      errorCode: null,
    });

    const [row] = await registry.healthReport("hollow");
    expect(row).toBeDefined();
    expect(row!.runs).toBe(5);
    // Perfect by the old measure, which is exactly the trap.
    expect(row!.successRate).toBe(1);
    expect(row!.emptyRuns).toBe(4);
    expect(row!.emptyRate).toBeCloseTo(0.8);
  });

  it("ranks a hollow Pilot above a loudly failing one in the repair queue", async () => {
    const version = "9.1.0";
    // Never returns anything, never complains.
    for (let i = 0; i < 4; i += 1) {
      await registry.report({
        pilotId: "quiet", version, ok: true, recordCount: 0, durationMs: 90, errorCode: null,
      });
    }
    // Fails a quarter of the time but delivers the rest.
    await registry.report({
      pilotId: "loud", version, ok: false, recordCount: 0, durationMs: 90, errorCode: "PILOT_BROKEN",
    });
    for (let i = 0; i < 3; i += 1) {
      await registry.report({
        pilotId: "loud", version, ok: true, recordCount: 7, durationMs: 90, errorCode: null,
      });
    }

    const rows = (await registry.healthReport()).filter((row) => row.version === version);
    expect(rows.map((row) => row.pilotId)).toEqual(["quiet", "loud"]);
  });
});

describe("package lifecycle", () => {
  it("detects, installs and removes a newer semantic version", async () => {
    const { pilot, code } = fixture();
    const local = {
      ...pilot,
      id: "updateboard",
      version: "1.9.0",
      capability: null,
      capabilitySchemaVersion: null,
    };
    const latest = { ...local, version: "1.10.0" };
    const store = new PilotStore(env);
    store.save(local, code);
    await registry.publish({ pilot: local, code });
    await registry.publish({ pilot: latest, code: `${code}\n// 1.10.0\n` });

    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect((await registry.fetch("updateboard")).version).toBe("1.10.0");
      expect(await runOutdated(env, { positional: ["updateboard"], flags: { json: true } })).toBe(0);
      const status = JSON.parse(writes.splice(0).join("")) as Array<{ status: string }>;
      expect(status[0]?.status).toBe("outdated");

      expect(await runUpdate(env, { positional: ["updateboard"], flags: { json: true } })).toBe(0);
      writes.splice(0);
      store.reload();
      expect(store.get("updateboard").pilot.version).toBe("1.10.0");
      expect(store.readScript("updateboard")).toContain("// 1.10.0");
      expect(JSON.parse(readFileSync(env.lockFile, "utf8")).pilots).toContainEqual({
        id: "updateboard",
        version: "1.10.0",
        capability: null,
      });

      expect(await runUninstall(env, { positional: ["updateboard"], flags: { json: true } })).toBe(0);
      store.reload();
      expect(() => store.get("updateboard")).toThrow(/No Pilot named/);
      expect(JSON.parse(readFileSync(env.lockFile, "utf8")).pilots).not.toContainEqual(
        expect.objectContaining({ id: "updateboard" }),
      );

      new PilotLock(env).set(latest);
      expect(await runInstall(env, { positional: [], flags: {} })).toBe(0);
      store.reload();
      expect(store.get("updateboard").pilot.version).toBe("1.10.0");
      expect(await runUninstall(env, { positional: ["updateboard"], flags: { json: true } })).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it("reuses a compatible registry implementation before creating a model client", async () => {
    const { pilot, code } = fixture();
    const published = {
      ...pilot,
      id: "reuseboard",
      target: { name: "Reuse Board", url: "https://reuse.example/jobs?q=engineer" },
    };
    await registry.publish({ pilot: published, code });

    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await runCreate(
        { ...env, openaiApiKey: null, compilerModel: null },
        parseArgs([
          "https://reuse.example/jobs?q=designer",
          "--id",
          "reuseboard",
          "--capability",
          "jobs.board@1",
        ]),
      );
      expect(exitCode).toBe(0);
      expect(writes.join("")).toMatch(/no model call/i);
      expect(new PilotStore(env).get("reuseboard").pilot.version).toBe(published.version);
    } finally {
      write.mockRestore();
    }
  });
});
