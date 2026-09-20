#!/usr/bin/env node
import { loadEnv } from "../shared/env.js";
import { toPilotError } from "../shared/errors.js";
import { parseArgs, flagNumber, flagString, assertKnownFlags } from "./args.js";
import { runCreate } from "./create.js";
import { runList } from "./list.js";
import { runSearch } from "./search.js";
import { runRepair } from "./repair.js";
import { runCapabilities } from "./capabilities.js";
import { runFields } from "./fields.js";

const HELP = `Pilot — compile any website into a reusable data API.

  pilot create <url>            Reuse a published Pilot, or compile when missing
    --id <name>                 Pilot id (default: derived from the hostname)
    --name <label>              Human-readable target name
    --capability <id>           Target a capability schema (default: jobs.board@1)
    --fields <a,b,c>            Ad-hoc extraction instead of a capability
    --query <text>              Sample query used while validating
    --from-skill <ref>          Start from published notes about the site:
                                a browse.sh skill (indeed.com/search-jobs-8yxl6y,
                                or just indeed.com when it is unambiguous), or a
                                local markdown file
    --attempts <n>              Compile attempts before giving up (default: 3)
    --compile                   Ignore registry matches and force a fresh compile

  pilot list                    Show installed Pilots and whether they are enabled
  pilot list <capability>       Show every published Pilot for a function type
                               e.g. pilot list jobs.board@1
  pilot capabilities            Show shared function types and schema versions
  pilot capabilities show <id>  One capability, field by field
  pilot capabilities add <id>   Declare a capability before any Pilot implements it
    --describe <text>           Design the fields from a plain description
    --fields <a,b,c>            name[:type][!][=description], ! marks required
    --from <file.json>          Field definitions from a file instead
    --dry-run                   Show the shape without declaring it
  pilot capabilities publish <id>  Share the interface through the registry
  pilot capabilities install <id>  Take someone else's interface (--force to replace)
  pilot fields [targets...]     Which fields the selected Pilots return, and how
                                many of them provide each one (--json)
  pilot enable <id>             Include a Pilot in unqualified searches
  pilot disable <id>            Exclude it

  pilot search [targets...]     Run a search across Pilots
    --capability <id>           Function type (default: jobs.board@1)
    --keywords <text>           Filter by keywords
    --location <text>           Filter by location
    --type <type>               internship | full-time | part-time | contract
    --limit <n>                 Max results per Pilot
    --filter <field=value,...>  Filter generated fields, e.g. seniority=Senior
    --param <field=value,...>   Parameters for non-job capabilities
    --json                      Machine-readable output

  pilot repair <id>             Recompile a Pilot whose site changed
  pilot testboard               Serve the local job board used for testing

  pilot publish <id>            Push a compiled Pilot to the shared registry
  pilot install [id@version]    Install one, or restore pilot.lock.json
  pilot outdated [ids...]       Compare installed versions with the registry
  pilot update [ids...]         Install newer published versions (all by default)
  pilot uninstall <ids...>      Remove every local version of a Pilot
  pilot lock                    Snapshot installed versions into pilot.lock.json
  pilot registry list           Every published Pilot, newest version
  pilot registry search <text>  Find a Pilot by site, capability, or field
  pilot registry versions <id>  Published versions of one Pilot
  pilot registry health [id]    Success rate per Pilot, worst first
  pilot registry capabilities   Every published capability, newest schema

  pilot promptlab [--runs n]    A/B the compiler's system prompts

  pilot mcp                     Serve Pilot over MCP (stdio) to Claude Code,
                                Codex, or any other MCP client

Examples:
  pilot search                        every enabled Pilot
  pilot search indeed                 just Indeed
  pilot search indeed linkedin        both, merged and deduped
`;

/**
 * What each command accepts. The point is not tidiness — it is that an
 * unrecognized flag used to vanish silently, and `pilot search --query ...`
 * (the right flag for `create`, the wrong one for `search`) then ran a
 * keyword-less search and printed a screen of real jobs matching nothing.
 */
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  create: [
    "id", "name", "capability", "fields", "query", "location", "from-skill",
    "attempts", "steps", "compile", "watch",
  ],
  list: ["json"],
  capabilities: ["fields", "from", "describe", "dry-run", "force", "json"],
  fields: ["json"],
  enable: [],
  disable: [],
  search: [
    "capability", "keywords", "location", "type", "limit", "filter", "param",
    "strict-location", "json", "no-report",
  ],
  repair: ["query", "failure"],
  publish: [],
  install: [],
  outdated: ["json"],
  update: ["json"],
  uninstall: ["json"],
  lock: ["json"],
  registry: ["capability", "limit", "json"],
  promptlab: ["runs"],
  mcp: [],
  testboard: ["port", "layout", "hostile", "delay"],
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const env = loadEnv();

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const known = KNOWN_FLAGS[command];
  if (known) assertKnownFlags(command, args, known);

  switch (command) {
    case "create":
      return runCreate(env, args);
    case "list":
      return runList(env, args);
    case "capabilities":
      return runCapabilities(env, args);
    case "fields":
      return runFields(env, args);
    case "enable":
    case "disable": {
      const id = args.positional[0];
      if (!id) {
        process.stderr.write(`Usage: pilot ${command} <id>\n`);
        return 1;
      }
      const { PilotStore } = await import("../pilots/store.js");
      const store = new PilotStore(env);
      store.get(id);
      store.setEnabled(id, command === "enable");
      process.stdout.write(`${id} ${command}d\n`);
      return 0;
    }
    case "search":
      return runSearch(env, args);
    case "repair":
      return runRepair(env, args);
    case "publish": {
      const { runPublish } = await import("./registry.js");
      return runPublish(env, args);
    }
    case "install": {
      const { runInstall } = await import("./registry.js");
      return runInstall(env, args);
    }
    case "outdated": {
      const { runOutdated } = await import("./packages.js");
      return runOutdated(env, args);
    }
    case "update": {
      const { runUpdate } = await import("./packages.js");
      return runUpdate(env, args);
    }
    case "uninstall": {
      const { runUninstall } = await import("./packages.js");
      return runUninstall(env, args);
    }
    case "lock": {
      const { runLock } = await import("./packages.js");
      return runLock(env, args);
    }
    case "registry": {
      const { runRegistry } = await import("./registry.js");
      return runRegistry(env, args);
    }
    case "promptlab": {
      const { runPromptLab } = await import("../promptlab/run.js");
      return runPromptLab(flagNumber(args, "runs") ?? 3);
    }
    case "mcp": {
      // Stdio transport: stdout is the JSON-RPC stream from here on. Anything
      // this process prints to it corrupts the protocol.
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer(env);
      return -1; // the transport owns the process now
    }
    case "testboard": {
      const { startTestBoard } = await import("../testboard/server.js");
      const port = flagNumber(args, "port") ?? env.testBoardPort;
      const layout = flagString(args, "layout") ?? "a";
      const hostile = args.flags.hostile === true;
      await startTestBoard({
        port,
        layout: layout === "b" ? "b" : "a",
        hostile,
        hostileDelayMs: flagNumber(args, "delay"),
      });
      process.stdout.write(
        `Test board running at http://127.0.0.1:${port}/ (layout ${layout}${hostile ? ", hostile" : ""})\n`,
      );
      return -1; // keep the process alive
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

try {
  const code = await main();
  if (code >= 0) process.exit(code);
} catch (cause) {
  const error = toPilotError(cause);
  process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exit(1);
}
