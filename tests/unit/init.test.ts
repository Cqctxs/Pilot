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

/**
 * A real enough project. The directories have to be actual paths, not
 * undefined: `init` now reports what is installed, and `fs.existsSync(undefined)`
 * answers false while warning — a test that passes through that path is
 * testing Node's deprecation behaviour rather than ours.
 */
function project(): PilotEnv {
  const root = mkdtempSync(path.join(tmpdir(), "pilot-init-"));
  return {
    projectRoot: root,
    pilotsDir: path.join(root, "pilots"),
    capabilitiesDir: path.join(root, "config", "capabilities"),
    configFile: path.join(root, "config", "pilots.json"),
    lockFile: path.join(root, "pilot.lock.json"),
    registryUri: null,
  } as PilotEnv;
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

  /**
   * Claude Code reads CLAUDE.md and Codex reads AGENTS.md. The note is the
   * same either way, so which agent someone happens to use should not decide
   * whether the project explains itself.
   */
  it("writes the note for both Claude Code and Codex", () => {
    const env = project();
    runInit(env, parseArgs([]));
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      expect(readFileSync(path.join(env.projectRoot, name), "utf8")).toContain("## Pilot");
    }
  });

  it("appends to an existing AGENTS.md too, and only once", () => {
    const env = project();
    const file = path.join(env.projectRoot, "AGENTS.md");
    writeFileSync(file, "# Conventions\n\nPrefer small commits.\n");
    runInit(env, parseArgs([]));
    runInit(env, parseArgs([]));
    const note = readFileSync(file, "utf8");
    expect(note).toContain("Prefer small commits.");
    expect(note.split("## Pilot").length - 1).toBe(1);
  });

  /**
   * Codex keeps MCP servers in a global config, so registering there is opt-in.
   * A bare `init` sets up the directory and nothing outside it.
   */
  it("does not touch Codex without the flag", () => {
    const env = project();
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      runInit(env, parseArgs([]));
    } finally {
      process.stdout.write = write;
    }
    const output = lines.join("");
    expect(output).not.toContain("Registered");
    expect(output).toMatch(/--codex|npx pilot mcp/);
  });

  it("refuses to guess at a malformed .mcp.json", () => {
    const env = project();
    writeFileSync(path.join(env.projectRoot, ".mcp.json"), "{ not json");
    expect(() => runInit(env, parseArgs([]))).toThrow(/not valid JSON/);
  });
});

describe("pilot init state report", () => {
  it("names the next command for an empty project", () => {
    const env = project();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      runInit(env, parseArgs([]));
    } finally {
      process.stdout.write = write;
    }
    const printed = out.join("");
    expect(printed).toContain("0 Pilot(s)");
    expect(printed).toContain("pilot create <url>");
    // No registry configured, so publishing and installing need saying.
    expect(printed).toContain("PILOT_REGISTRY_URI");
  });

  /** A fresh clone has the lockfile and nothing else; restoring is the step. */
  it("prefers restoring a lockfile over compiling something new", () => {
    const env = project();
    writeFileSync(path.join(env.projectRoot, "pilot.lock.json"), '{"pilots":[]}');
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      runInit(env, parseArgs([]));
    } finally {
      process.stdout.write = write;
    }
    const printed = out.join("");
    expect(printed).toContain("pilot install");
    expect(printed).not.toContain("compile the first one");
  });
});
