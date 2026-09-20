#!/usr/bin/env node
import { loadEnv } from "../shared/env.js";
import { toPilotError } from "../shared/errors.js";
import { parseArgs, flagNumber, flagString, assertKnownFlags } from "./args.js";
import { runCreate } from "./create.js";
import { runList, runOverview } from "./list.js";
import { asCapabilityArgs, asRegistryArgs, kindOf } from "./route.js";
import { runSearch } from "./search.js";
import { runRepair } from "./repair.js";
import { runCapabilities } from "./capabilities.js";
import { runFields } from "./fields.js";
import { runInit } from "./init.js";
import { runTypes } from "./types.js";

const HELP = `Pilot — compile any website into a reusable data API.

  A capability is an interface (jobs.search). A Pilot implements it for one
  site (linkedin). You write code against the capability, forever.

CORE

  pilot create <url>            Get a Pilot for a site — reuses a published one,
                                compiles only when nobody has done it yet
    --capability <id>           Interface it should implement (default: jobs.search)
    --fields <a,b,c>            Ad-hoc extraction instead, for a one-off
    --watch                     Show the browser while it explores
    --compile                   Force a fresh compile even if a match exists

  pilot create <capability>     Declare an interface before anything implements it
    --describe <text>           Design the fields from a plain description
    --url <url>                 Design them from a real page of that kind
    --fields <a,b,c>            name[:type][!][=description], ! marks required
    --dry-run                   Print the shape without keeping it

  pilot search [pilots...]      Run a search across every enabled Pilot
    --keywords / --location     What to look for
    --capability <id>           Interface to search (default: jobs.search)
    --limit <n> --json          Cap per Pilot; machine-readable output

  pilot publish <pilot|capability>   Share it, so the next person skips compiling
  pilot install [pilot|capability]   Take someone else's; bare, restores the lockfile

LOOK

  pilot ls                      Capabilities and the Pilots implementing them
  pilot ls <capability>         Every published Pilot for that interface
  pilot ls --remote             Everything in the registry
  pilot show <pilot|capability> Fields, tier by tier
  pilot health [pilot]          Success rate per Pilot, worst first

KEEP WORKING

  pilot repair <pilot>          Recompile one whose site changed
  pilot update [pilots...]      Install newer published versions
  pilot rm <pilot|capability>   Remove it locally
  pilot enable|disable <pilot>  Include or exclude from unqualified searches
  pilot lock                    Snapshot versions into pilot.lock.json

  pilot init                    Let this project's coding agent see your Pilots
                                (writes .mcp.json + a CLAUDE.md note)
  pilot types                   Generate TypeScript for the installed
                                capabilities, so wrong field names fail to compile
  pilot mcp                     Serve Pilot over MCP to Claude Code or Codex
  pilot help --all              The rest of the surface

Examples:
  pilot create "https://www.talent.com/jobs?k=software+intern&l=Boston"
  pilot search --keywords "software intern" --location Boston
  pilot create hotels.search --describe "hotels I could book, with nightly price"
`;

const HELP_ALL = `The rest of the surface — everything the short help leaves out.

  Not in the short help:
    pilot registry search <text>  Find a Pilot by site, capability, or field
    pilot registry versions <id>  Published versions of one Pilot
    pilot registry capabilities   Every published capability
    pilot outdated [pilots...]    Compare installed versions with the registry
    pilot create --from-skill <ref>   Compile starting from published notes
    pilot search --type <t> --filter <f=v> --param <f=v> --strict-location
    pilot types [--out <file>]    TypeScript for the installed capabilities
    pilot init [--force]          Set this project up for a coding agent
    pilot testboard [--layout a|b] [--hostile]  Local board used by the tests
    pilot promptlab [--runs n]    A/B the compiler's system prompts
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
    // `create <capability>` declares an interface rather than compiling a site.
    "describe", "url", "from", "dry-run", "json",
  ],
  list: ["json", "remote"],
  init: ["force"],
  types: ["out", "dry-run"],
  ls: ["json", "remote"],
  show: ["json"],
  rm: ["json", "force"],
  health: ["json", "limit"],
  enable: [],
  disable: [],
  search: [
    "capability", "keywords", "location", "type", "limit", "filter", "param",
    "strict-location", "json", "no-report",
  ],
  repair: ["query", "failure"],
  publish: [],
  install: ["force"],
  outdated: ["json"],
  update: ["json"],
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
    process.stdout.write(args.flags.all === true || argv.includes("--all") ? HELP_ALL : HELP);
    return 0;
  }

  const known = KNOWN_FLAGS[command];
  if (known) assertKnownFlags(command, args, known);

  switch (command) {
    case "create": {
      // A capability id here means "declare this interface"; anything else is a
      // site to compile. Same verb, because both answer "make me a new thing".
      const target = args.positional[0];
      if (target && kindOf(target) === "capability") {
        return runCapabilities(env, asCapabilityArgs(args, "add", target));
      }
      return runCreate(env, args);
    }
    case "types":
      return runTypes(env, args);
    case "init":
      return runInit(env, args);
    case "ls":
    case "list": {
      const target = args.positional[0];
      if (!target && !args.flags.remote) return runOverview(env, args);
      if (args.flags.remote) {
        const { runRegistry } = await import("./registry.js");
        return runRegistry(env, asRegistryArgs(args, "list"));
      }
      return runList(env, args);
    }
    case "show": {
      const target = args.positional[0];
      if (!target) {
        process.stderr.write("Usage: pilot show <pilot|capability>\n");
        return 1;
      }
      if (kindOf(target) === "capability") {
        return runCapabilities(env, asCapabilityArgs(args, "show", target));
      }
      return runFields(env, args);
    }
    case "rm": {
      const target = args.positional[0];
      if (!target) {
        process.stderr.write("Usage: pilot rm <pilot|capability>\n");
        return 1;
      }
      if (kindOf(target) === "capability") {
        return runCapabilities(env, asCapabilityArgs(args, "rm", target));
      }
      const { runUninstall } = await import("./packages.js");
      return runUninstall(env, args);
    }
    case "health": {
      const { runRegistry } = await import("./registry.js");
      return runRegistry(env, asRegistryArgs(args, "health"));
    }
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
      const target = args.positional[0];
      if (target && kindOf(target) === "capability") {
        return runCapabilities(env, asCapabilityArgs(args, "publish", target));
      }
      const { runPublish } = await import("./registry.js");
      return runPublish(env, args);
    }
    case "install": {
      // Bare `install` restores pilot.lock.json, the npm-shaped default.
      const target = args.positional[0];
      if (target && kindOf(target) === "capability") {
        return runCapabilities(env, asCapabilityArgs(args, "install", target));
      }
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
