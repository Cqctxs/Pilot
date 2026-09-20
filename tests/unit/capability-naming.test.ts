/**
 * What you type versus what is stored.
 *
 * `jobs.board@1` was awkward in two separate ways, and they have different
 * answers. The `@1` is a real part of the contract — it is what a Pilot's
 * recorded `capabilitySchemaVersion` refers to — so it stays on disk and
 * becomes optional at the keyboard. The `board` was simply the wrong word for
 * an interface whose sibling capabilities are named for verbs, so it was
 * renamed. The old name is simply gone: it lived for one release, nothing
 * outside this repo depends on it, and an interface with two names has none.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CapabilityRegistry } from "../../src/capability/registry.js";
import { JOBS_CAPABILITY } from "../../src/capability/jobs.js";

function registryWith(ids: string[]): CapabilityRegistry {
  const dir = mkdtempSync(path.join(tmpdir(), "pilot-caps-"));
  for (const id of ids) {
    writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        capabilityFormatVersion: 1,
        id,
        version: "1.0.0",
        schema: { name: id, fields: [{ name: "title", type: "string", required: true, description: "t" }] },
        coreFields: ["title"],
      }),
    );
  }
  return new CapabilityRegistry({ capabilitiesDir: dir });
}

describe("capability naming", () => {
  it("renamed jobs.board@1 to jobs.search@1", () => {
    expect(JOBS_CAPABILITY).toBe("jobs.search@1");
  });

  it("resolves a short name to the installed major", () => {
    const registry = registryWith(["hotels.search@2"]);
    expect(registry.resolve("hotels.search")).toBe("hotels.search@2");
  });

  it("assumes @1 for a name nothing has declared yet", () => {
    expect(registryWith([]).resolve("flights.search")).toBe("flights.search@1");
  });

  /**
   * The one case where the suffix is still required. Two majors are two
   * different contracts; picking one would be a guess, and a guess here returns
   * records shaped wrongly rather than an error.
   */
  it("refuses a short name when two majors are installed", () => {
    const registry = registryWith(["hotels.search@1", "hotels.search@2"]);
    expect(() => registry.resolve("hotels.search")).toThrow(/major versions/);
    expect(registry.resolve("hotels.search@2")).toBe("hotels.search@2");
  });

  /**
   * One interface, one name.
   *
   * `jobs.board@1` was aliased to `jobs.search@1` for one release, and the
   * aliases cost more than the migration they bought: the docs said
   * `jobs.search`, the MCP tool reported `jobs.board@1`, the SDK constant said
   * `jobs.search@1`, and `capability()` took four spellings. Someone comparing
   * the docs to the tool output concluded they disagreed — correctly. The old
   * name is now simply unknown, and says so.
   */
  it("does not answer to the pre-rename id", () => {
    const registry = registryWith(["jobs.search@1"]);
    expect(registry.resolve("jobs.board@1")).toBe("jobs.board@1");
    expect(registry.find("jobs.board@1")).toBeNull();
    // A bare word with no dot is not a capability id at all.
    expect(() => registry.resolve("jobs")).not.toThrow();
    expect(registry.find("jobs.search@1")).not.toBeNull();
  });

});
