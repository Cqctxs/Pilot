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

  /**
   * A page grounds the design; it does not become the design. The evidence
   * here is written by hand rather than fetched so the assertion is about the
   * model's judgement and not about what some real site happened to show that
   * day: `bookingReference` is plainly one site's internal artifact, and a
   * capability that requires it is a scrape of that site wearing an interface.
   */
  it("takes names from a page without inheriting its site-specific fields", async () => {
    const designed = await designCapability({
      id: "hotels.search@1",
      description: "hotels I could book, with what a night costs",
      evidence: {
        url: "https://example.test/hotels?city=boston",
        text: [
          "status: 200",
          "title: Hotels in Boston",
          "",
          "visible text:",
          "Harbor View Inn — Downtown Boston — $249/night — 4.5 (812 reviews)",
          "Our ref: BKG-40192 · Loyalty tier: Gold · 3 left at this price",
          "Fenway Lodge — Back Bay — $187/night — 4.1 (233 reviews)",
          "Our ref: BKG-40193 · Loyalty tier: Silver · 8 left at this price",
        ].join("\n"),
      },
      env: loadEnv(),
    });

    const names = designed.fields.map((field) => field.name);
    expect(names.some((name) => /price|rate|cost/i.test(name))).toBe(true);

    // The page's own bookkeeping may be proposed as optional — that is a
    // judgement call — but nothing only this site has may be required.
    const required = designed.fields.filter((field) => field.required).map((field) => field.name);
    expect(required.some((name) => /ref|loyalty|tier|remaining|left/i.test(name))).toBe(false);
    expect(required.length).toBeLessThanOrEqual(3);

    // "Boston" was all over the page. It is a query value, not a field.
    expect(names.some((name) => /boston/i.test(name))).toBe(false);
  }, 180_000);
});
