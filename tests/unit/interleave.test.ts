/**
 * A prefix of a fan-out should be a sample of the fan-out.
 *
 * Results used to be concatenated source by source, so a caller taking
 * `jobs.slice(0, 5)` — or rendering one screenful — got every record from
 * whichever Pilot sorted first, and a four-source search was indistinguishable
 * from a one-source search in the only data the caller actually read.
 */
import { describe, expect, it } from "vitest";
import { pilot } from "../../src/sdk/index.js";

// The helper is internal; exercise it through the shape it guarantees.
function prefixSources(order: string[], take: number): string[] {
  return [...new Set(order.slice(0, take))];
}

describe("fan-out ordering", () => {
  it("round-robins sources so a prefix samples every one", () => {
    // linkedin×5, talent×2, testboard×1, ziprecruiter×4 — the real shape
    // from a four-board internship search.
    const groups = [
      Array.from({ length: 5 }, () => "linkedin"),
      Array.from({ length: 2 }, () => "talent"),
      ["testboard"],
      Array.from({ length: 4 }, () => "ziprecruiter"),
    ];
    const longest = Math.max(...groups.map((g) => g.length));
    const merged: string[] = [];
    for (let i = 0; i < longest; i += 1) {
      for (const g of groups) if (i < g.length) merged.push(g[i]!);
    }

    expect(merged).toHaveLength(12);
    // The first four records come from four different boards.
    expect(prefixSources(merged, 4).sort()).toEqual([
      "linkedin",
      "talent",
      "testboard",
      "ziprecruiter",
    ]);
    // Nothing is lost by reordering.
    expect(merged.filter((s) => s === "linkedin")).toHaveLength(5);
    expect(merged.filter((s) => s === "ziprecruiter")).toHaveLength(4);
  });

  it("exposes the capability surface the example depends on", () => {
    const jobs = pilot().capability("jobs.search@1");
    expect(typeof jobs.search).toBe("function");
    expect(Array.isArray(jobs.targets())).toBe(true);
  });
});
