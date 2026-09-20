import { describe, expect, it } from "vitest";
import {
  extendDataSchema,
  fieldsWithoutValues,
  type DataSchema,
} from "../../src/shared/schema.js";

const BASE: DataSchema = {
  name: "example@1",
  fields: [
    { name: "title", type: "string", required: true, description: "Title" },
  ],
};

describe("extendDataSchema", () => {
  it("adds validated model-proposed fields as optional fields", () => {
    const result = extendDataSchema(BASE, [
      { name: "seniority", type: "string", description: "Experience level" },
      { name: "remote", type: "boolean", description: "Whether the role is remote" },
    ]);

    expect(result.problems).toEqual([]);
    expect(result.added.map((field) => field.name)).toEqual(["seniority", "remote"]);
    expect(result.schema.fields.slice(1)).toEqual([
      { name: "seniority", type: "string", required: false, description: "Experience level" },
      { name: "remote", type: "boolean", required: false, description: "Whether the role is remote" },
    ]);
  });

  it("reuses a compatible existing field instead of duplicating it", () => {
    const result = extendDataSchema(BASE, [
      { name: "title", type: "string", description: "Website role label" },
    ]);

    expect(result.problems).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.schema.fields).toHaveLength(1);
  });

  it("rejects invalid names and conflicting types", () => {
    const result = extendDataSchema(BASE, [
      { name: "Salary Range", type: "string", description: "Salary" },
      { name: "title", type: "number", description: "Wrong type" },
    ]);

    expect(result.problems).toHaveLength(2);
    expect(result.schema).toEqual(BASE);
  });

  it("identifies proposed fields that validation did not actually extract", () => {
    const extension = extendDataSchema(BASE, [
      { name: "salary", type: "number", description: "Annual salary" },
      { name: "seniority", type: "string", description: "Experience level" },
    ]);

    expect(
      fieldsWithoutValues(
        [
          { title: "Engineer", salary: null, seniority: "Senior" },
          { title: "Designer", salary: null, seniority: null },
        ],
        extension.added,
      ),
    ).toEqual(["salary"]);
  });
});

describe("extendDataSchema on a draft capability", () => {
  const EMPTY: DataSchema = { name: "postings.board@1", fields: [] };

  it("lets a proposal be required only when it is designing the schema", () => {
    const proposal = [
      { name: "title", type: "string", description: "The posting title", required: true },
      { name: "salary", type: "string", description: "Pay range", required: true },
    ];

    const draft = extendDataSchema(EMPTY, proposal);
    expect(draft.added.map((field) => [field.name, field.required])).toEqual([
      ["title", true],
      ["salary", true],
    ]);

    // The same proposal against an existing capability: every other Pilot
    // already implements that interface without these, so requiring them would
    // retroactively break them.
    const existing = extendDataSchema(BASE, proposal);
    expect(existing.added.every((field) => field.required === false)).toBe(true);
  });

  it("ignores a missing or non-boolean required flag", () => {
    const result = extendDataSchema(EMPTY, [
      { name: "title", type: "string", description: "The posting title" },
      { name: "company", type: "string", description: "Who posted it", required: "yes" },
    ]);
    expect(result.added.every((field) => field.required === false)).toBe(true);
  });
});
