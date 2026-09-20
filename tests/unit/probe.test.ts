/**
 * The check that catches a Pilot which ignores its query.
 *
 * Reported from real use: two flight Pilots baked YTO-YVR/2026-10-20 into the
 * script and into the emitted departureDate. Both passed — twenty real records,
 * every field populated, validation green — and both would have returned
 * Toronto→Vancouver for every query anyone ever made. Validation re-ran the
 * same query the script had hardcoded, so it was self-confirming.
 *
 * The judgement is tested here directly, without a browser: what matters is
 * which record sets count as evidence of a script reading its query.
 */
import { describe, expect, it } from "vitest";
import { judgeProbe, probeQuery } from "../../src/compiler/validate.js";
import type { ScriptQuery } from "../../src/runtime/script.js";

const query: ScriptQuery = { keywords: "software intern", location: "Toronto", limit: null };

describe("probeQuery", () => {
  it("varies every non-empty string in the query", () => {
    const probe = probeQuery(query)!;
    expect(probe.keywords).not.toBe(query.keywords);
    expect(probe.location).not.toBe(query.location);
  });

  it("keeps a date a date, so the site still answers", () => {
    const probe = probeQuery({ ...query, departureDate: "2026-10-20" })!;
    expect(probe.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(probe.departureDate).not.toBe("2026-10-20");
  });

  /** Nothing to vary: a site with no search is legitimately constant. */
  it("declines to probe an empty query", () => {
    expect(probeQuery({ keywords: "", location: "", limit: null })).toBeNull();
  });
});

describe("judgeProbe", () => {
  const records = [{ title: "A", url: "https://x/1" }, { title: "B", url: "https://x/2" }];

  it("fails a script that answers identically to a different question", () => {
    const problem = judgeProbe(records, records, query, probeQuery(query)!);
    expect(problem).toMatch(/identical records for two different queries/);
    // The message has to name what changed, or the model cannot act on it.
    expect(problem).toContain("software intern");
  });

  it("passes a script whose output changed", () => {
    const other = [{ title: "C", url: "https://x/3" }];
    expect(judgeProbe(records, other, query, probeQuery(query)!)).toBeNull();
  });

  /** Zero results for an unrelated query is the site being asked and having nothing. */
  it("treats an empty probe result as proof the query was used", () => {
    expect(judgeProbe(records, [], query, probeQuery(query)!)).toBeNull();
  });

  it("says nothing when the first run found nothing to compare", () => {
    expect(judgeProbe([], [], query, probeQuery(query)!)).toBeNull();
  });

  /** Order is not identity: the same records shuffled are still the same records. */
  it("ignores key order within a record", () => {
    const reordered = [{ url: "https://x/1", title: "A" }, { url: "https://x/2", title: "B" }];
    expect(judgeProbe(records, reordered, query, probeQuery(query)!)).not.toBeNull();
  });
});
