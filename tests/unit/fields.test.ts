import { describe, expect, it } from "vitest";
import { describeFields } from "../../src/capability/fields.js";
import type { CapabilityDefinition } from "../../src/capability/registry.js";
import type { Pilot } from "../../src/shared/pilot.js";
import type { FieldSpec } from "../../src/shared/schema.js";

const CORE: FieldSpec[] = [
  { name: "title", type: "string", required: true, description: "Job title" },
  { name: "url", type: "url", required: true, description: "Posting link" },
];

const SALARY: FieldSpec = {
  name: "salary",
  type: "string",
  required: false,
  description: "Pay range",
};

const SENIORITY: FieldSpec = {
  name: "seniority",
  type: "string",
  required: false,
  description: "Seniority level",
};

const DEFINITION: CapabilityDefinition = {
  capabilityFormatVersion: 1,
  id: "jobs.search@1",
  version: "1.1.0",
  // `salary` was promoted after two sites agreed on it; core is what shipped.
  schema: { name: "jobs.search@1", fields: [...CORE, SALARY] },
  coreFields: ["title", "url"],
};

function pilot(id: string, extras: FieldSpec[], capability: string | null = "jobs.search@1"): Pilot {
  return {
    pilotFormatVersion: 2,
    id,
    version: "1.0.0",
    target: { name: id, url: `https://${id}.example` },
    capability,
    capabilitySchemaVersion: capability ? "1.1.0" : null,
    schema: { name: capability ?? "adhoc", fields: [...CORE, ...extras] },
    schemaExtensions: extras,
    artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
    discovered: [],
    origin: "handwritten",
    createdAt: new Date(0).toISOString(),
    compiler: null,
    evidence: { recordCount: 1, checkedAt: new Date(0).toISOString(), sampleFile: null },
  };
}

const definitions = new Map([["jobs.search@1", DEFINITION]]);

describe("describeFields", () => {
  it("tiers fields as core, shared, or site-local", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY]), pilot("linkedin", [SALARY, SENIORITY])],
      definitions,
    );

    expect(groups).toHaveLength(1);
    const tiers = Object.fromEntries(groups[0]!.fields.map((field) => [field.name, field.tier]));
    expect(tiers).toEqual({ title: "core", url: "core", salary: "shared", seniority: "local" });
  });

  it("reports how many sources provide each field", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY]), pilot("linkedin", [SALARY, SENIORITY]), pilot("talent", [])],
      definitions,
    );
    const byName = new Map(groups[0]!.fields.map((field) => [field.name, field]));

    expect(byName.get("title")).toMatchObject({ available: 3, total: 3 });
    expect(byName.get("salary")).toMatchObject({ available: 2, total: 3 });
    expect(byName.get("seniority")).toMatchObject({
      available: 1,
      total: 3,
      providedBy: ["linkedin"],
    });
  });

  it("puts core fields first and site-local fields last", () => {
    const groups = describeFields([pilot("indeed", [SENIORITY, SALARY])], definitions);
    expect(groups[0]!.fields.map((field) => field.name)).toEqual([
      "title",
      "url",
      "salary",
      "seniority",
    ]);
  });

  it("describes a shared field with the capability's wording, not one site's", () => {
    const renamed: FieldSpec = { ...SALARY, description: "whatever indeed calls it" };
    const groups = describeFields([pilot("indeed", [renamed])], definitions);
    const salary = groups[0]!.fields.find((field) => field.name === "salary");
    expect(salary?.description).toBe("Pay range");
  });

  it("groups ad-hoc Pilots separately, with every field local", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY]), pilot("scratch", [], null)],
      definitions,
    );

    expect(groups.map((group) => group.capability)).toEqual(["jobs.search@1", null]);
    const adhoc = groups[1]!;
    expect(adhoc.schemaVersion).toBeNull();
    expect(adhoc.fields.every((field) => field.tier === "local")).toBe(true);
  });
});

describe("describeFields fill evidence", () => {
  it("separates a field a Pilot declares from one it actually fills", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY]), pilot("linkedin", [SALARY])],
      definitions,
      new Map([
        ["indeed", [{ title: "Engineer", url: "https://a/1", salary: "$120,000" }]],
        // Declared in the schema, null on every record — the trap this catches.
        ["linkedin", [{ title: "Designer", url: "https://b/1", salary: null }]],
      ]),
    );
    const salary = groups[0]!.fields.find((field) => field.name === "salary");

    expect(salary).toMatchObject({ available: 2, total: 2, populated: 1, measured: 2 });
  });

  it("counts a blank string as unfilled", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY])],
      definitions,
      new Map([["indeed", [{ salary: "   " }, { salary: "" }]]]),
    );
    expect(groups[0]!.fields.find((field) => field.name === "salary")).toMatchObject({
      populated: 0,
      measured: 1,
    });
  });

  it("takes evidence only from Pilots that declare the field", () => {
    const groups = describeFields(
      [pilot("indeed", [SALARY]), pilot("talent", [])],
      definitions,
      new Map([
        ["indeed", [{ salary: "$120,000" }]],
        // talent has samples but does not declare salary, so it is not evidence.
        ["talent", [{ title: "Nurse" }]],
      ]),
    );
    expect(groups[0]!.fields.find((field) => field.name === "salary")).toMatchObject({
      available: 1,
      total: 2,
      populated: 1,
      measured: 1,
    });
  });

  it("reports no measurement rather than zero when there are no samples", () => {
    const groups = describeFields([pilot("indeed", [SALARY])], definitions);
    expect(groups[0]!.fields.every((field) => field.measured === 0)).toBe(true);
  });
});
