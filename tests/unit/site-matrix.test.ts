import { describe, expect, it } from "vitest";
import { SITE_MATRIX } from "../fixtures/site-matrix.js";

describe("public live-site matrix", () => {
  it("has two distinct, documented sources in every category", () => {
    for (const group of SITE_MATRIX) {
      expect(group.sites).toHaveLength(2);
      expect(new Set(group.sites.map((site) => new URL(site.url).hostname)).size).toBe(2);
      for (const site of group.sites) {
        expect(site.access.length).toBeGreaterThan(20);
        expect(new URL(site.policyUrl).protocol).toBe("https:");
      }
    }
  });

  it("uses globally unique Pilot ids and HTTPS targets", () => {
    const sites = SITE_MATRIX.flatMap((group) => [...group.sites]);
    expect(new Set(sites.map((site) => site.id)).size).toBe(sites.length);
    for (const site of sites) expect(new URL(site.url).protocol).toBe("https:");
  });
});
