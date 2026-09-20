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
import { pilot } from "pilot";

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
  return 0;
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
