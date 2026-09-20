/**
 * The MCP server, driven by a real MCP client over a real stdio pipe.
 *
 * Mocking the transport would miss the failure that actually matters here: any
 * stray write to stdout corrupts the JSON-RPC stream. That only shows up when
 * something genuinely speaks the protocol down a pipe, so this test spawns the
 * CLI the same way Claude Code or Codex would.
 *
 * No model and no external network — only the local board.
 */
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../../src/capability/jobs.js";
import { findProjectRoot } from "../../src/shared/env.js";
import { startTestBoard } from "../../src/testboard/server.js";

const projectRoot = findProjectRoot();

function scriptFor(base: string): string {
  return `export async function search(page, query) {
  const url = \`${base}/api/jobs?q=\${encodeURIComponent(query.keywords || "")}&loc=\${encodeURIComponent(query.location || "")}\`;
  const response = await fetch(url);
  const body = await response.json();
  return body.results.map((job) => ({
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    employmentType: job.employmentType,
    postedAt: job.postedAt,
  }));
}
`;
}

let board: Server;
let root: string;
let client: Client;

/** Text payload of a tool result, whatever content blocks it used. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {});
}

beforeAll(async () => {
  board = await startTestBoard({ port: 0, layout: "a" });
  const address = board.address();
  if (!address || typeof address === "string") throw new Error("Test board did not bind to a TCP port");
  const base = `http://127.0.0.1:${address.port}`;

  // A Pilot directory of our own, so the test never touches the repo's Pilots.
  root = mkdtempSync(path.join(tmpdir(), "pilot-mcp-"));
  const dir = path.join(root, "pilots", "testboard", "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "extract.mjs"), scriptFor(base));
  writeFileSync(
    path.join(dir, "pilot.json"),
    JSON.stringify({
      pilotFormatVersion: 2,
      id: "testboard",
      version: "1.0.0",
      target: { name: "Test Board", url: `${base}/jobs` },
      capability: JOBS_CAPABILITY,
      schema: JOBS_SCHEMA,
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
      discovered: [],
      origin: "handwritten",
      createdAt: new Date().toISOString(),
      compiler: null,
      evidence: { recordCount: 6, checkedAt: new Date().toISOString(), sampleFile: null },
    }),
  );

  client = new Client({ name: "pilot-test-client", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/cli/main.ts", "mcp"],
      cwd: projectRoot,
      env: {
        ...(process.env as Record<string, string>),
        PILOT_PILOTS_DIR: path.join(root, "pilots"),
        PILOT_CONFIG: path.join(root, "pilots.json"),
        // No registry: registry-backed tools must degrade, not crash.
        PILOT_REGISTRY_URI: "",
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => board?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("handshake", () => {
  it("advertises the full tool surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "pilot_capabilities",
      "pilot_create",
      "pilot_fields",
      "pilot_health",
      "pilot_inspect",
      "pilot_install",
      "pilot_list",
      "pilot_publish",
      "pilot_registry_search",
      "pilot_repair",
      "pilot_run",
      "pilot_search",
    ]);
  });

  it("describes pilot_create well enough for an agent to choose it", async () => {
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === "pilot_create");
    // The agent has to learn two things from the description alone: that this
    // is how you get data off a site with no API, and that it is slow.
    expect(create?.description).toMatch(/no API/i);
    expect(create?.description).toMatch(/SLOW|minutes/i);
    expect(create?.inputSchema.required).toContain("url");
  });
});

describe("reading data", () => {
  it("lists installed Pilots with their fields", async () => {
    const result = await client.callTool({ name: "pilot_list", arguments: {} });
    expect(textOf(result)).toContain("testboard@1.0.0");
    const pilots = structured(result).pilots as Array<{ id: string; fields: string[] }>;
    expect(pilots[0]!.fields).toContain("company");
  });

  it("reports which fields are available and how many sources provide them", async () => {
    const result = await client.callTool({ name: "pilot_fields", arguments: {} });
    const body = textOf(result);

    expect(body).toContain("jobs.search@1");
    // One Pilot installed, so every capability field is core and fully covered.
    expect(body).toContain("title: string required [core] declared 1/1");
    const groups = structured(result).capabilities as Array<{
      capability: string;
      fields: Array<{ name: string; tier: string; available: number; total: number }>;
    }>;
    expect(groups[0]?.capability).toBe("jobs.search@1");
    expect(groups[0]?.fields.every((field) => field.available === field.total)).toBe(true);
  });

  it("searches job boards and returns structured jobs", async () => {
    const result = await client.callTool({
      name: "pilot_search",
      arguments: { targets: ["testboard"], keywords: "engineer" },
    });
    expect(result.isError).toBeFalsy();
    const jobs = structured(result).jobs as Array<{ title: string; url: string }>;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.url.startsWith("http"))).toBe(true);
    expect(textOf(result)).toMatch(/job\(s\) from 1\/1 source/);
  });

  /**
   * Reported from real use: two flight Pilots had their sample values written
   * into the URL, so they returned the same records for every query and said
   * success. Finding that out meant locating pilots/<id>/<version>/extract.mjs
   * on disk, which meant reading src/shared/env.ts to learn where that is. One
   * call now answers it, and names the query keys the script actually reads.
   */
  it("shows a script and which query keys it reads", async () => {
    const result = await client.callTool({ name: "pilot_inspect", arguments: { id: "testboard" } });
    expect(result.isError).toBeFalsy();
    const body = textOf(result);
    expect(body).toContain("reads query: ");
    const keys = structured(result).readsQueryKeys as string[];
    expect(keys).toContain("keywords");
    expect(keys).toContain("location");
    expect(String(structured(result).script)).toContain("export async function search");
  });

  it("runs a Pilot directly for raw records", async () => {
    const result = await client.callTool({
      name: "pilot_run",
      arguments: { id: "testboard", keywords: "engineer" },
    });
    expect(result.isError).toBeFalsy();
    expect((structured(result).records as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("failure handling", () => {
  it("returns an unknown Pilot as a tool error the agent can read, not a crash", async () => {
    const result = await client.callTool({ name: "pilot_run", arguments: { id: "nosuchpilot" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNKNOWN_PILOT");
  });

  it("degrades gracefully when no registry is configured", async () => {
    const search = await client.callTool({ name: "pilot_registry_search", arguments: {} });
    expect(search.isError).toBeFalsy();
    expect(textOf(search)).toMatch(/No registry configured/);

    const health = await client.callTool({ name: "pilot_health", arguments: {} });
    expect(health.isError).toBeFalsy();
    expect(textOf(health)).toMatch(/No registry configured/);
  });

  it("stays on the protocol after an error", async () => {
    // A corrupted stdout stream shows up as the next call hanging or failing.
    const result = await client.callTool({ name: "pilot_list", arguments: {} });
    expect(result.isError).toBeFalsy();
  });
});
