/**
 * The one file that decides whether an agent can see any of this.
 *
 * `pilot mcp` already served the tools and the consumer already had the
 * binary; what was missing was `.mcp.json`, so nothing ever started the
 * server. An agent in that project then had four compiled Pilots sitting on
 * disk, no way to learn it, and every reason to write a scraper instead.
 *
 * Both files here belong to the user, so the tests that matter are the ones
 * about not trampling them.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInit } from "../../src/cli/init.js";
import { parseArgs } from "../../src/cli/args.js";
import type { PilotEnv } from "../../src/shared/env.js";

function project(): PilotEnv {
  const root = mkdtempSync(path.join(tmpdir(), "pilot-init-"));
  return { projectRoot: root } as PilotEnv;
}

describe("pilot init", () => {
  it("writes an .mcp.json that starts the installed binary", () => {
    const env = project();
    runInit(env, parseArgs([]));
    const config = JSON.parse(readFileSync(path.join(env.projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers.pilot).toEqual({ command: "npx", args: ["pilot", "mcp"] });
  });

  /** A project's other servers are none of our business. */
  it("merges into an existing .mcp.json instead of replacing it", () => {
    const env = project();
    writeFileSync(
      path.join(env.projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
    );
    runInit(env, parseArgs([]));
    const config = JSON.parse(readFileSync(path.join(env.projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(config.mcpServers.pilot).toBeDefined();
  });

  it("appends to a CLAUDE.md rather than overwriting the project's own", () => {
    const env = project();
    const file = path.join(env.projectRoot, "CLAUDE.md");
    writeFileSync(file, "# House rules\n\nRun the tests before committing.\n");
    runInit(env, parseArgs([]));
    const note = readFileSync(file, "utf8");
    expect(note).toContain("Run the tests before committing.");
    expect(note).toContain("## Pilot");
  });

  it("is idempotent — running twice does not duplicate the note", () => {
    const env = project();
    runInit(env, parseArgs([]));
    runInit(env, parseArgs([]));
    const note = readFileSync(path.join(env.projectRoot, "CLAUDE.md"), "utf8");
    expect(note.split("## Pilot").length - 1).toBe(1);
  });

  it("refuses to guess at a malformed .mcp.json", () => {
    const env = project();
    writeFileSync(path.join(env.projectRoot, ".mcp.json"), "{ not json");
    expect(() => runInit(env, parseArgs([]))).toThrow(/not valid JSON/);
  });
});
