/**
 * The check that catches a Pilot which ignores its query.
 *
 * Reported from real use: two flight Pilots baked YTO-YVR/2026-10-20 into the
 * script and into the emitted departureDate. Both passed — twenty real records,
 * every field populated, validation green — and both would have returned
 * Toronto→Vancouver for every query anyone ever made.
 *
 * The first version of this check varied every key at once, which the same
 * reporter then broke: a script that reads the route but writes the date in as
 * a literal answers differently when the route changes, so it passed. Varying
 * one key at a time is the only version that can name which input is wrong.
 */
import { describe, expect, it } from "vitest";
import { probeKeys, probeQuery, varyValue } from "../../src/compiler/validate.js";
import type { ScriptQuery } from "../../src/runtime/script.js";

const jobs: ScriptQuery = { keywords: "software intern", location: "Toronto", limit: null };
const flights: ScriptQuery = {
  keywords: "",
  location: "",
  limit: null,
  departureAirport: "YYZ",
  arrivalAirport: "YUL",
  departureDate: "2026-11-15",
};

describe("probeKeys", () => {
  it("probes only the keys that carry a value", () => {
    expect(probeKeys(jobs)).toEqual(["keywords", "location"]);
  });

  /**
   * Date first. Date-only hardcoding is the common metasearch failure and the
   * one a whole-query probe cannot see, so it should not be the key that falls
   * off the end of the budget.
   */
  it("probes dates before anything else", () => {
    expect(probeKeys(flights)[0]).toBe("departureDate");
  });

  /**
   * The compile validates with an empty query, so this is the shape the probe
   * actually meets. Before this case it returned nothing and every freshly
   * compiled Pilot recorded `probe.ran: false` — the check was installed and
   * inert.
   */
  it("fills in blank keys when the query says nothing at all", () => {
    expect(probeKeys({ keywords: "", location: "", limit: null })).toEqual([
      "keywords",
      "location",
    ]);
  });

  /**
   * Every query carries keywords and location whether or not the capability
   * means anything by them. Probing them next to a real flights query would
   * fail a correct Pilot for ignoring a key it is right to ignore.
   */
  it("leaves blank keys alone when the query already says something", () => {
    expect(probeKeys(flights)).not.toContain("keywords");
    expect(probeKeys(flights)).not.toContain("location");
  });

  it("does not invent a value for a key it has no stand-in for", () => {
    expect(probeKeys({ keywords: "", location: "", limit: null, cabinClass: "" })).not.toContain(
      "cabinClass",
    );
  });

  it("caps the number of probe runs", () => {
    const wide: ScriptQuery = { keywords: "a", location: "b", limit: null };
    for (let index = 0; index < 10; index += 1) wide[`extra${index}`] = `value${index}`;
    expect(probeKeys(wide).length).toBeLessThanOrEqual(4);
  });
});

describe("probeQuery", () => {
  it("changes exactly one key and leaves the rest alone", () => {
    const probe = probeQuery(flights, "departureDate");
    expect(probe.departureDate).not.toBe(flights.departureDate);
    // The reported false pass: these two stayed put, so a script that reads the
    // route still returns the same records, and only the date is under test.
    expect(probe.departureAirport).toBe("YYZ");
    expect(probe.arrivalAirport).toBe("YUL");
  });

  it("keeps a date a date, so the site still answers", () => {
    expect(varyValue("departureDate", "2026-10-20")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(varyValue("departureDate", "2026-10-20")).not.toBe("2026-10-20");
  });

  it("varies an unknown key without needing to know what it means", () => {
    expect(varyValue("cabinClass", "economy")).not.toBe("economy");
  });
});

/**
 * The scenario in the report, end to end through the judgement: a script that
 * reads the route and hardcodes the date. The route probes differ, the date
 * probe does not, and only the per-key version notices.
 */
describe("partial hardcoding", () => {
  const first = [{ from: "YYZ", to: "YUL", date: "2026-11-15" }];

  function outcomeFor(readKeys: string[]): { read: string[]; unread: string[] } {
    const read: string[] = [];
    const unread: string[] = [];
    for (const key of probeKeys(flights)) {
      // Simulate the script: it returns something different only for the keys
      // it actually reads.
      const answered = readKeys.includes(key) ? [{ from: "OSL", to: "AKL", date: "x" }] : first;
      (JSON.stringify(answered) === JSON.stringify(first) ? unread : read).push(key);
    }
    return { read, unread };
  }

  it("catches a date written into the script while the route is read", () => {
    const { read, unread } = outcomeFor(["departureAirport", "arrivalAirport"]);
    expect(unread).toEqual(["departureDate"]);
    expect(read).toEqual(["departureAirport", "arrivalAirport"]);
  });

  it("reports nothing when every key is read", () => {
    const { unread } = outcomeFor(["departureDate", "departureAirport", "arrivalAirport"]);
    expect(unread).toEqual([]);
  });
});
