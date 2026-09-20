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

describe("CapabilityRegistry promotion evidence", () => {
  const posted: FieldSpec = {
    name: "postedAt",
    type: "string",
    required: false,
    description: "When it was posted",
  };

  it("blocks a field two sites spell the same way but fill differently", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);

    const result = store.promoteFromPilots(
      "hotels.search@1",
      [pilot("one", posted), pilot("two", posted)],
      {
        samples: new Map([
          ["one", [{ postedAt: "6 hours ago" }, { postedAt: "2 days ago" }]],
          ["two", [{ postedAt: "2026-09-14" }, { postedAt: "2026-09-15" }]],
        ]),
      },
    );

    expect(result.promoted).toEqual([]);
    expect(result.definition.version).toBe("1.0.0");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.field).toBe("postedAt");
    expect(result.blocked[0]?.reason).toContain("one=relativeTime");
    expect(result.blocked[0]?.reason).toContain("two=isoDate");
  });

  it("promotes when the values agree as well as the types", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);

    const result = store.promoteFromPilots(
      "hotels.search@1",
      [pilot("one", posted), pilot("two", posted)],
      {
        samples: new Map([
          ["one", [{ postedAt: "2026-09-14" }]],
          ["two", [{ postedAt: "2026-09-15" }]],
        ]),
      },
    );

    expect(result.promoted.map((field) => field.name)).toEqual(["postedAt"]);
    expect(result.blocked).toEqual([]);
  });

  it("treats a Pilot with no usable sample as no evidence, not as disagreement", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);

    const result = store.promoteFromPilots(
      "hotels.search@1",
      [pilot("one", posted), pilot("two", posted)],
      { samples: new Map([["one", [{ postedAt: "2026-09-14" }]], ["two", []]]) },
    );

    expect(result.promoted.map((field) => field.name)).toEqual(["postedAt"]);
  });

  it("reports a type disagreement as blocked rather than silently skipping it", () => {
    const store = registry();
    store.ensure("hotels.search@1", BASE);
    const numeric: FieldSpec = {
      name: "stars",
      type: "number",
      required: false,
      description: "Star rating",
    };

    const result = store.promoteFromPilots("hotels.search@1", [
      pilot("one", numeric),
      pilot("two", { ...numeric, type: "string" }),
    ]);

    expect(result.promoted).toEqual([]);
    expect(result.blocked[0]).toMatchObject({ field: "stars" });
    expect(result.blocked[0]?.reason).toContain("number and string");
  });

  it("refuses to write a capability that has lost a core field", () => {
    const store = registry();
    const created = store.ensure("hotels.search@1", BASE);
    expect(created.coreFields).toEqual(["name", "url"]);

    // Reach past promotion: nothing in the public API drops a core field today,
    // and this is the guard that keeps it that way.
    const writeDefinition = Reflect.get(store, "write") as (value: unknown) => void;
    expect(() =>
      writeDefinition.call(store, {
        ...created,
        schema: { ...created.schema, fields: created.schema.fields.filter((f) => f.name !== "url") },
      }),
    ).toThrow(/cannot drop core field/i);
  });
});

describe("CapabilityRegistry.define", () => {
  it("declares a capability before anything implements it", () => {
    const store = registry();
    const definition = store.define("hotels.search@1", BASE);

    expect(definition.version).toBe("1.0.0");
    expect(definition.schema.name).toBe("hotels.search@1");
    expect(definition.coreFields).toEqual(["name", "url"]);
    expect(store.get("hotels.search@1")).toEqual(definition);
  });

  it("refuses to redefine one Pilots may already have compiled against", () => {
    const store = registry();
    store.define("hotels.search@1", BASE);
    expect(() => store.define("hotels.search@1", BASE)).toThrow(/already exists/);
    // The message has to point somewhere useful, and @1 is not the answer.
    expect(() => store.define("hotels.search@1", BASE)).toThrow(/hotels\.search@2/);
  });

  it("rejects an empty schema", () => {
    const store = registry();
    expect(() => store.define("hotels.search@1", { name: "x", fields: [] })).toThrow(/at least one field/);
  });

  it("save() accepts a revision from elsewhere, unlike define()", () => {
    const store = registry();
    const promoted = {
      capabilityFormatVersion: 1 as const,
      id: "hotels.search@1",
      version: "1.3.0",
      schema: { ...BASE, name: "hotels.search@1" },
      coreFields: ["name", "url"],
    };
    expect(store.save(promoted).version).toBe("1.3.0");
    expect(store.get("hotels.search@1").version).toBe("1.3.0");
  });
});
