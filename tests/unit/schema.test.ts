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
