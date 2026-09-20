/**
 * What you type versus what is stored.
 *
 * `jobs.board@1` was awkward in two separate ways, and they have different
 * answers. The `@1` is a real part of the contract — it is what a Pilot's
 * recorded `capabilitySchemaVersion` refers to — so it stays on disk and
 * becomes optional at the keyboard. The `board` was simply the wrong word for
 * an interface whose sibling capabilities are named for verbs, so it was
 * renamed, and the old name has to keep working forever: it is written into
 * every Pilot and registry document published before the rename.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CapabilityRegistry,
  canonicalCapability,
  capabilityAliases,
} from "../../src/capability/registry.js";
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

  it("still answers to the pre-rename id, with or without its version", () => {
    const registry = registryWith(["jobs.search@1"]);
    expect(registry.resolve("jobs.board@1")).toBe("jobs.search@1");
    expect(registry.resolve("jobs.board")).toBe("jobs.search@1");
    expect(registry.resolve("jobs")).toBe("jobs.search@1");
  });

  it("canonicalizes without touching the disk, and without merging majors", () => {
    expect(canonicalCapability("jobs.board@1")).toBe("jobs.search@1");
    expect(canonicalCapability("hotels.search@2")).toBe("hotels.search@2");
    expect(canonicalCapability(null)).toBeNull();
  });

  it("lists every id a published document might carry", () => {
    expect(capabilityAliases("jobs.search@1")).toContain("jobs.board@1");
    expect(capabilityAliases("jobs.search@1")[0]).toBe("jobs.search@1");
    expect(capabilityAliases("hotels.search@1")).toEqual(["hotels.search@1"]);
  });
});
