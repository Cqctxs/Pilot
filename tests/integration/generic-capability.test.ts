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
          // A number, because the capability declares one. This used to be the
          // string "5": only `url` was coerced, so every other declared type
          // was a promise the runtime did not keep. Consumers then compare
          // these across sources, and "143" < "9" is true.
          stars: 5,
        },
      },
    ]);
  });

  /**
   * The declared type is kept even when the site wraps it in currency, commas
   * or units, and a value that is not the declared type becomes null rather
   * than a string in a number field — a missing field is reported by
   * required-field validation, while a wrong-typed one type checks and lies.
   */
  it("coerces declared types out of the text a site actually shows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pilot-coerce-"));
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
        { name: "url", type: "url" as const, required: true, description: "Booking link" },
        { name: "price", type: "number" as const, required: false, description: "Nightly price" },
        { name: "refundable", type: "boolean" as const, required: false, description: "Free cancellation" },
      ],
    };
    const artifact: Pilot = {
      pilotFormatVersion: 2,
      id: "hotel-b",
      version: "1.0.0",
      target: { name: "Hotel B", url: "https://hotels.example/search" },
      capability: "hotels.search@1",
      capabilitySchemaVersion: "1.0.0",
      schema,
      schemaExtensions: [],
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
      discovered: [],
      origin: "handwritten",
      createdAt: new Date(0).toISOString(),
      compiler: null,
      evidence: { recordCount: 2, checkedAt: new Date(0).toISOString(), sampleFile: null },
    };
    // Exactly what a site hands over: a formatted price, a word for a boolean,
    // and a price that is not a price at all.
    const code = `export async function search(page, query) {
  return [
    { name: "Grand", url: "https://hotels.example/3", price: "$1,299.50", refundable: "yes" },
    { name: "Budget", url: "https://hotels.example/4", price: "call us", refundable: "no" }
  ];
}`;
    new PilotStore(env).save(artifact, code);
    new PilotStore(env).setEnabled("hotel-b", true);

    const hotels = createPilot(env).capability("hotels.search@1");
    const { records } = await hotels.search("hotel-b");
    expect(records.map((record) => record.values.price)).toEqual([1299.5, null]);
    expect(records.map((record) => record.values.refundable)).toEqual([true, false]);

    // The point of the coercion, stated as the comparison that used to break.
    const prices = records.map((record) => record.values.price).filter((p): p is number => p !== null);
    expect(Math.min(...prices)).toBe(1299.5);
  });
});
