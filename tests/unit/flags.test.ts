/**
 * Unknown flags must fail, not vanish.
 *
 * `--query` is correct for `pilot create` and wrong for `pilot search`. When
 * the parser dropped it silently, the search ran with no keywords and printed
 * a screenful of real, well-formatted jobs that matched nothing, exiting 0.
 * A wrong answer that looks right is worse than an error.
 */
import { describe, expect, it } from "vitest";
import { assertKnownFlags, parseArgs } from "../../src/cli/args.js";

const SEARCH_FLAGS = ["capability", "keywords", "location", "type", "limit", "json"];

describe("assertKnownFlags", () => {
  it("accepts flags the command declares", () => {
    const args = parseArgs(["--keywords", "software engineer", "--limit", "5"]);
    expect(() => assertKnownFlags("search", args, SEARCH_FLAGS)).not.toThrow();
  });

  it("rejects the create/search --query mix-up", () => {
    const args = parseArgs(["--query", "software engineer"]);
    expect(() => assertKnownFlags("search", args, SEARCH_FLAGS)).toThrow(/Unknown flag --query/);
  });

  it("suggests the flag that was probably meant", () => {
    const args = parseArgs(["--keyword", "x"]);
    expect(() => assertKnownFlags("search", args, SEARCH_FLAGS)).toThrow(/Did you mean --keywords/);
  });

  it("lists the known flags so the fix needs no second command", () => {
    const args = parseArgs(["--nonsense"]);
    expect(() => assertKnownFlags("search", args, SEARCH_FLAGS)).toThrow(/--capability, --keywords/);
  });

  it("leaves a command with no flags alone", () => {
    expect(() => assertKnownFlags("mcp", parseArgs([]), [])).not.toThrow();
  });
});
