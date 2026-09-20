/**
 * Live: does a sentence produce a usable interface?
 *
 * The risk with generating a schema from prose is that it describes one
 * website rather than a function type — a union of everything the model can
 * imagine, with everything marked required. Those are the two properties worth
 * asserting; the exact field names are the model's call.
 */
import { describe, expect, it } from "vitest";
import { designCapability } from "../../src/compiler/design.js";
import { loadEnv } from "../../src/shared/env.js";

describe("designCapability", () => {
  it("designs a hotels capability from one sentence", async () => {
    const env = loadEnv();
    const designed = await designCapability({
      id: "hotels.search@1",
      description: "get hotel prices and locations in the area",
      env,
    });

    expect(designed.fields.length).toBeGreaterThanOrEqual(3);

    // An interface many sites implement cannot demand much. Identity and a
    // link are defensible; a required price is not, because a listing without
    // a shown price is still a listing.
    const required = designed.fields.filter((f) => f.required);
    expect(required.length).toBeLessThanOrEqual(3);
    expect(required.length).toBeGreaterThanOrEqual(1);

    // Prices are numbers, links are urls — the types have to be usable.
    const link = designed.fields.find((f) => f.type === "url");
    expect(link, "expected a url-typed field").toBeDefined();
    const price = designed.fields.find((f) => /price|rate|cost/i.test(f.name));
    expect(price?.type).toBe("number");

    // Every field carries a real description; they are written into every
    // future compiler prompt for this capability.
    for (const field of designed.fields) {
      expect(field.description.length).toBeGreaterThan(10);
    }

    // The location was asked for, so it must be there in some form.
    expect(
      designed.fields.some((f) => /location|address|city|area|neighbou?rhood/i.test(f.name)),
    ).toBe(true);
  }, 180_000);

  it("refuses an empty description without calling the model", async () => {
    await expect(
      designCapability({ id: "x@1", description: "   ", env: loadEnv() }),
    ).rejects.toThrow(/needs a sentence/);
  });
});
