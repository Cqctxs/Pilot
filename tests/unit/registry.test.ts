import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/capability/registry.js";
import type { Pilot } from "../../src/shared/pilot.js";
import type { DataSchema, FieldSpec } from "../../src/shared/schema.js";

const roots: string[] = [];
const BASE: DataSchema = {
  name: "hotels.search@1",
  fields: [
    { name: "name", type: "string", required: true, description: "Hotel name" },
    { name: "url", type: "url", required: true, description: "Hotel URL" },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): CapabilityRegistry {
  const root = mkdtempSync(path.join(tmpdir(), "pilot-capabilities-"));
  roots.push(root);
  return new CapabilityRegistry({ capabilitiesDir: root });
}

function pilot(id: string, extension: FieldSpec): Pilot {
  return {
    pilotFormatVersion: 2,
    id,
    version: "1.0.0",
    target: { name: id, url: `https://${id}.example` },
    capability: "hotels.search@1",
    capabilitySchemaVersion: "1.0.0",
    schema: { ...BASE, fields: [...BASE.fields, extension] },
    schemaExtensions: [extension],
    artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
    discovered: [],
    origin: "handwritten",
    createdAt: new Date(0).toISOString(),
    compiler: null,
    evidence: { recordCount: 1, checkedAt: new Date(0).toISOString(), sampleFile: null },
  };
}

describe("CapabilityRegistry", () => {
  it("creates and reloads a shared base schema", () => {
    const store = registry();
    expect(store.find("hotels.search@1")).toBeNull();
    const created = store.ensure("hotels.search@1", BASE);

    expect(created.version).toBe("1.0.0");
    expect(created.coreFields).toEqual(["name", "url"]);
    expect(store.get("hotels.search@1")).toEqual(created);
    expect(store.find("hotels.search@1")).toEqual(created);
  });

  it("keeps a field Pilot-local until multiple Pilots support it", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);
    const stars: FieldSpec = {
      name: "stars",
      type: "number",
      required: false,
      description: "Hotel star rating",
    };

    expect(store.promoteFromPilots("hotels.search@1", [pilot("one", stars)]).promoted).toEqual([]);

    const result = store.promoteFromPilots("hotels.search@1", [
      pilot("one", stars),
      pilot("two", stars),
    ]);
    expect(result.promoted.map((field) => field.name)).toEqual(["stars"]);
    expect(result.definition.version).toBe("1.1.0");
    expect(store.get("hotels.search@1").schema.fields.at(-1)?.name).toBe("stars");
  });

  it("does not promote conflicting field types", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);
    const numeric: FieldSpec = {
      name: "stars",
      type: "number",
      required: false,
      description: "Star rating",
    };
    const textual: FieldSpec = { ...numeric, type: "string" };

    const result = store.promoteFromPilots("hotels.search@1", [
      pilot("one", numeric),
      pilot("two", textual),
    ]);
    expect(result.promoted).toEqual([]);
    expect(result.definition.version).toBe("1.0.0");
  });
});
