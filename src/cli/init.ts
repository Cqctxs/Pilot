/**
 * Make an application's agent aware of its Pilots.
 *
 * Everything needed already existed — `pilot mcp` serves the tools, and the
 * consumer project has a `pilot` binary the moment it depends on this package.
 * The missing piece was one config file: without `.mcp.json`, nothing ever
 * starts the server, so an agent working in that project cannot see that four
 * compiled Pilots are sitting right there and writes a scraper instead.
 *
 * This writes that file, and a short note for the agent explaining what it is
 * looking at. Both are additive and neither is overwritten without --force.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PilotStore } from "../pilots/store.js";
import { CapabilityRegistry } from "../capability/registry.js";
import type { PilotEnv } from "../shared/env.js";
import type { ParsedArgs } from "./args.js";

const SERVER_NAME = "pilot";

/**
 * `npx pilot mcp` rather than this repo's `npx tsx src/cli/main.ts mcp`: the
 * consumer has the package installed, not the source tree, and a relative path
 * into someone else's node_modules is not a thing to write into their config.
 */
const SERVER_CONFIG = {
  command: "npx",
  args: ["pilot", "mcp"],
};

const NOTE_HEADING = "## Pilot";

const NOTE = `${NOTE_HEADING}

This project depends on Pilot: compiled scripts that read data from sites with
no API. A **capability** is an interface (\`jobs.search\`); a **Pilot**
implements it for one site (\`linkedin\`). Application code targets the
capability, never a site.

- \`pilot_capabilities\` — the interfaces here, field by field. Read this before
  writing code against a result; a field marked \`*\` is on every record.
- \`pilot_list\` — which sites can be asked, and what each returns.
- \`pilot_search\` — run a search now.
- \`pilot_create\` — compile a new site, only when no Pilot covers it.

Running a Pilot costs no model call and needs no API key. Prefer an existing
Pilot over writing new extraction code, and prefer \`pilot_create\` over
hand-rolling a scraper: the compiled script is versioned, shared, and repairable.

\`\`\`ts
import { pilot } from "@pilot/sdk";

const jobs = pilot().capability("jobs.search");
const { jobs: found, sources } = await jobs.search({ keywords: "software intern" });
\`\`\`
`;

export function runInit(env: PilotEnv, args: ParsedArgs): number {
  const root = env.projectRoot;
  const force = args.flags.force === true;
  const written: string[] = [];
  const skipped: string[] = [];

  const mcpFile = path.join(root, ".mcp.json");
  const existing = existsSync(mcpFile) ? readJson(mcpFile) : null;
  const servers = (existing?.mcpServers ?? {}) as Record<string, unknown>;
  if (servers[SERVER_NAME] && !force) {
    skipped.push(`.mcp.json already configures "${SERVER_NAME}"`);
  } else {
    // Merged, not replaced. A project's other MCP servers are none of our
    // business, and clobbering them to add one entry would be a poor trade.
    writeFileSync(
      mcpFile,
      `${JSON.stringify({ ...existing, mcpServers: { ...servers, [SERVER_NAME]: SERVER_CONFIG } }, null, 2)}\n`,
    );
    written.push(".mcp.json");
  }

  const noteFile = path.join(root, "CLAUDE.md");
  const note = existsSync(noteFile) ? readFileSync(noteFile, "utf8") : "";
  if (note.includes(NOTE_HEADING) && !force) {
    skipped.push("CLAUDE.md already mentions Pilot");
  } else {
    writeFileSync(noteFile, note ? `${note.replace(/\n*$/, "\n")}\n${NOTE}` : NOTE);
    written.push(note ? "CLAUDE.md (appended)" : "CLAUDE.md");
  }

  for (const item of written) process.stdout.write(`Wrote ${item}\n`);
  for (const item of skipped) process.stdout.write(`Kept ${item} (--force to replace)\n`);
  if (written.length > 0) {
    process.stdout.write(
      `\nRestart Claude Code in this directory and it will see your Pilots.\n` +
        `Codex and other MCP clients: point them at \`npx pilot mcp\`.\n`,
    );
  }
  process.stdout.write(reportState(env, root));
  return 0;
}

/**
 * What this project has, and the one command that follows from it.
 *
 * Writing the config is only half of setup, and the other half is different in
 * every project — a fresh clone needs its Pilots restored, an empty folder
 * needs one compiled, a project with capabilities wants types generated. Rather
 * than a scaffolding command that guesses, say what is here and name the next
 * step. Guessing wrong is worse than asking: `pilot install` on a lockfile that
 * is not there is a confusing no-op, and compiling a site nobody asked for
 * spends a model call and several minutes.
 */
function reportState(env: PilotEnv, root: string): string {
  const pilots = new PilotStore(env).all();
  const capabilities = new CapabilityRegistry(env).all();
  const hasLock = existsSync(path.join(root, "pilot.lock.json"));
  const hasTypes = existsSync(path.join(root, "pilot-types.d.ts"));
  const registryReady = Boolean(env.registryUri);

  const lines = [
    `\nThis project: ${pilots.length} Pilot(s), ${capabilities.length} capability(ies)` +
      `, registry ${registryReady ? "configured" : "not configured"}\n`,
  ];

  const next: string[] = [];
  if (pilots.length === 0 && hasLock) {
    next.push("pilot install            restore the Pilots in pilot.lock.json");
  } else if (pilots.length === 0) {
    next.push("pilot create <url>       compile the first one");
    if (registryReady) next.push("pilot ls --remote        or take one someone published");
  }
  if (!registryReady) {
    next.push("PILOT_REGISTRY_URI=...   in .env, to install or publish shared Pilots");
  }
  if (capabilities.length > 0 && !hasTypes) {
    next.push("pilot types              TypeScript for the fields, so wrong names fail to compile");
  }
  if (next.length > 0) lines.push(`Next:\n${next.map((item) => `  ${item}`).join("\n")}\n`);
  return lines.join("");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A malformed .mcp.json is the user's file and their problem to fix; the
    // one thing not to do is silently overwrite it.
    throw new Error(`${file} is not valid JSON. Fix or remove it, then run init again.`);
  }
}
