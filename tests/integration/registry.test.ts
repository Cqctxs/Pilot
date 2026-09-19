/**
 * The registry against a real MongoDB.
 *
 * An in-memory server rather than Atlas: the point is to exercise the actual
 * driver, indexes and aggregation pipeline, and to do it without a network or
 * a shared database that other people are publishing into.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  env = { ...loadEnv(), registryUri: mongo.getUri(), registryDb: "pilot_test", publisher: "tester" };
  registry = await Registry.connect(env);
}, 120_000);

afterAll(async () => {
  await registry?.close();
  await mongo?.stop();
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
