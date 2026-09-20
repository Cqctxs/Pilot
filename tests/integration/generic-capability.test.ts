import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PilotStore } from "../../src/pilots/store.js";
import { pilot as createPilot } from "../../src/sdk/index.js";
import { loadEnv } from "../../src/shared/env.js";
import type { Pilot } from "../../src/shared/pilot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generic capabilities", () => {
  it("searches a non-job function type through its unified schema", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pilot-generic-"));
    roots.push(root);
    const env = {
      ...loadEnv(),
      pilotsDir: path.join(root, "pilots"),
      configFile: path.join(root, "pilots.json"),
      capabilitiesDir: path.join(root, "capabilities"),
    };
    const schema = {
      name: "hotels.search@1",
      fields: [
        { name: "name", type: "string" as const, required: true, description: "Hotel name" },
        { name: "url", type: "url" as const, required: true, description: "Hotel URL" },
        { name: "city", type: "string" as const, required: false, description: "City" },
        { name: "stars", type: "number" as const, required: false, description: "Star rating" },
      ],
    };
    const artifact: Pilot = {
      pilotFormatVersion: 2,
      id: "hotel-a",
      version: "1.0.0",
      target: { name: "Hotel A", url: "https://hotels.example/search" },
      capability: "hotels.search@1",
      capabilitySchemaVersion: "1.0.0",
      schema,
      schemaExtensions: [schema.fields[3]!],
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
      discovered: [],
      origin: "handwritten",
      createdAt: new Date(0).toISOString(),
      compiler: null,
      evidence: { recordCount: 2, checkedAt: new Date(0).toISOString(), sampleFile: null },
    };
    const code = `export async function search(page, query) {
  return [
    { name: "Harbour Hotel", url: "https://hotels.example/1", city: query.location || "Toronto", stars: 5 },
    { name: "Park Hotel", url: "https://hotels.example/2", city: query.location || "Toronto", stars: 4 }
  ];
}`;
    const store = new PilotStore(env);
    store.save(artifact, code);
    store.setEnabled("hotel-a", true);

    const hotels = createPilot(env).capability("hotels.search@1");
    const result = await hotels.search("hotel-a", {
      params: { location: "Montreal" },
      filters: { stars: 5 },
    });

    expect(result.fields).toEqual(["name", "url", "city", "stars"]);
    expect(result.records).toEqual([
      {
        source: "hotel-a",
        values: {
          name: "Harbour Hotel",
          url: "https://hotels.example/1",
          city: "Montreal",
          stars: "5",
        },
      },
    ]);
  });
});
