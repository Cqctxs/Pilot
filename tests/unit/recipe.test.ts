import { describe, expect, it } from "vitest";
import { parseRecipe } from "../../src/shared/recipe.js";
import { readPath } from "../../src/runtime/http-json.js";
import { fillTemplate, fillUrl } from "../../src/runtime/template.js";

const HTTP_RECIPE = {
  recipeFormatVersion: 1,
  kind: "http-json",
  request: { urlTemplate: "https://example.test/api?q={keywords}" },
  recordsPath: "results",
  fields: {
    title: { sources: [{ path: "title" }], allowMissing: false },
    url: { sources: [{ path: "url" }], allowMissing: false },
  },
};

describe("parseRecipe", () => {
  it("accepts a recipe that matches the schema", () => {
    const recipe = parseRecipe(HTTP_RECIPE, ["title", "url"]);
    expect(recipe.kind).toBe("http-json");
  });

  it("rejects a recipe that skips a required field", () => {
    expect(() => parseRecipe(HTTP_RECIPE, ["title", "url", "company"])).toThrow(/company/);
  });

  it("rejects a recipe that invents fields outside the schema", () => {
    expect(() => parseRecipe(HTTP_RECIPE, ["title"])).toThrow(/outside the schema/);
  });

  it("rejects unknown properties rather than silently ignoring them", () => {
    expect(() => parseRecipe({ ...HTTP_RECIPE, surprise: true }, ["title", "url"])).toThrow();
  });

  it("rejects prototype-polluting paths", () => {
    const bad = {
      ...HTTP_RECIPE,
      fields: {
        title: { sources: [{ path: "__proto__.title" }], allowMissing: false },
        url: { sources: [{ path: "url" }], allowMissing: false },
      },
    };
    expect(() => parseRecipe(bad, ["title", "url"])).toThrow();
  });
});

describe("readPath", () => {
  const document = { data: { results: [{ location: { name: "Boston" } }] } };

  it("walks objects and array indexes", () => {
    expect(readPath(document, "data.results[0].location.name")).toBe("Boston");
  });

  it("returns the root for $", () => {
    expect(readPath(document, "$")).toBe(document);
  });

  it("returns undefined instead of throwing on a missing path", () => {
    expect(readPath(document, "data.missing.deeply")).toBeUndefined();
  });
});

describe("templates", () => {
  it("substitutes variables and blanks unknown ones", () => {
    expect(fillTemplate("q={keywords}&l={location}", { keywords: "intern" })).toBe("q=intern&l=");
  });

  it("url-encodes substituted values", () => {
    expect(fillUrl("https://example.test/s?q={keywords}", { keywords: "software intern" })).toBe(
      "https://example.test/s?q=software%20intern",
    );
  });

  it("refuses a non-http scheme", () => {
    expect(() => fillUrl("file:///etc/passwd", {})).toThrow();
  });
});
