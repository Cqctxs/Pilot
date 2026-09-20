import { describe, expect, it } from "vitest";
import { compareVersions } from "../../src/shared/version.js";

describe("compareVersions", () => {
  it("compares semantic version parts numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("rejects versions outside Pilot's supported format", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow(/invalid versions/i);
  });
});
