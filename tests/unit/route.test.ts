/**
 * One verb, whichever object you name.
 *
 * The router exists because the CLI had two grammars — verb-first everywhere
 * except capabilities and the registry, which were noun-first namespaces. The
 * ids are what make collapsing them safe, so these tests pin the three shapes
 * apart rather than the routing table, which is the part that will move.
 */
import { describe, expect, it } from "vitest";
import { kindOf } from "../../src/cli/route.js";

describe("kindOf", () => {
  it("reads a site from its scheme or path", () => {
    expect(kindOf("https://www.talent.com/jobs?k=intern")).toBe("url");
    expect(kindOf("http://127.0.0.1:4100/jobs")).toBe("url");
    expect(kindOf("example.com/jobs")).toBe("url");
  });

  it("reads a capability from its dot or its version", () => {
    expect(kindOf("jobs.search")).toBe("capability");
    expect(kindOf("jobs.search@1")).toBe("capability");
    expect(kindOf("hotels.search@2")).toBe("capability");
  });

  it("reads a Pilot from a bare word, which is all its id pattern allows", () => {
    expect(kindOf("linkedin")).toBe("pilot");
    expect(kindOf("tb-designed")).toBe("pilot");
  });

  /**
   * `example.com` looks like the ambiguous case and is not: a scheme-less
   * hostname throws in `new URL`, so it was never usable as a target. Reading
   * it as a capability costs nothing that worked before.
   */
  it("does not treat a scheme-less hostname as a site", () => {
    expect(() => new URL("example.com")).toThrow();
    expect(kindOf("example.com")).toBe("capability");
  });
});
