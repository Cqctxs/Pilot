/**
 * `pilot list capabilities` used to answer.
 *
 * `list` takes a capability id, so the guess was read as "published Pilots
 * implementing the function type named capabilities", which found none and
 * printed "Nothing found." with exit 0. The command the user wanted —
 * `pilot capabilities` — existed the whole time. A confident empty answer is
 * the same failure as the silent `--query` drop: it ends the search for the
 * real command instead of starting it.
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { runList } from "../../src/cli/list.js";
import { loadEnv } from "../../src/shared/env.js";

describe("pilot list <argument>", () => {
  it("rejects a command name where a capability id belongs", async () => {
    await expect(runList(loadEnv(), parseArgs(["capabilities"]))).rejects.toThrow(
      /not a capability id/,
    );
  });

  it("names the command that was actually wanted", async () => {
    await expect(runList(loadEnv(), parseArgs(["capabilities"]))).rejects.toThrow(
      /pilot capabilities/,
    );
  });

  it("rejects a Pilot id too — list takes function types, not Pilots", async () => {
    await expect(runList(loadEnv(), parseArgs(["linkedin"]))).rejects.toThrow(
      /not a capability id/,
    );
  });
});
