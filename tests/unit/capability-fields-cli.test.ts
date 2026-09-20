import { describe, expect, it } from "vitest";
import { parseCapabilityFields } from "../../src/cli/capabilities.js";

describe("parseCapabilityFields", () => {
  it("reads name, type, required marker and description", () => {
    expect(
      parseCapabilityFields("name!=Hotel name,url:url!=Link,stars:number=Star rating,city"),
    ).toEqual([
      { name: "name", type: "string", required: true, description: "Hotel name" },
      { name: "url", type: "url", required: true, description: "Link" },
      { name: "stars", type: "number", required: false, description: "Star rating" },
      { name: "city", type: "string", required: false, description: "city" },
    ]);
  });

  it("infers url from a name ending in url", () => {
    expect(parseCapabilityFields("detailUrl")[0]).toMatchObject({ type: "url" });
  });

  it("rejects a field it cannot read rather than guessing", () => {
    expect(() => parseCapabilityFields("Not A Field")).toThrow(/Cannot read field/);
    expect(() => parseCapabilityFields("price:money")).toThrow(/Cannot read field/);
  });

  it("needs at least one field", () => {
    expect(() => parseCapabilityFields("  , ,")).toThrow(/at least one field/);
  });
});
