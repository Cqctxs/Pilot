#!/usr/bin/env node
import { loadEnv } from "../shared/env.js";
import { toPilotError } from "../shared/errors.js";
import { parseArgs, flagNumber, flagString } from "./args.js";
import { runCreate } from "./create.js";
import { runList } from "./list.js";
import { runSearch } from "./search.js";
import { runRepair } from "./repair.js";

const HELP = `Pilot — compile any website into a reusable data API.

  pilot create <url>            Compile a new Pilot from a live site
    --id <name>                 Pilot id (default: derived from the hostname)
    --name <label>              Human-readable target name
    --capability <id>           Target a capability schema (default: jobs.board@1)
    --fields <a,b,c>            Ad-hoc extraction instead of a capability
    --query <text>              Sample query used while validating
    --attempts <n>              Compile attempts before giving up (default: 3)

  pilot list                    Show installed Pilots and whether they are enabled
  pilot enable <id>             Include a Pilot in unqualified searches
  pilot disable <id>            Exclude it

  pilot search [targets...]     Run a search across Pilots
    --keywords <text>           Filter by keywords
    --location <text>           Filter by location
    --type <type>               internship | full-time | part-time | contract
    --limit <n>                 Max results per Pilot
    --json                      Machine-readable output

  pilot repair <id>             Recompile a Pilot whose site changed
  pilot testboard               Serve the local job board used for testing

Examples:
  pilot search                        every enabled Pilot
  pilot search indeed                 just Indeed
  pilot search indeed linkedin        both, merged and deduped
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const env = loadEnv();

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "create":
      return runCreate(env, args);
    case "list":
      return runList(env, args);
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
    case "testboard": {
      const { startTestBoard } = await import("../testboard/server.js");
      const port = flagNumber(args, "port") ?? env.testBoardPort;
      const layout = flagString(args, "layout") ?? "a";
      await startTestBoard({ port, layout: layout === "b" ? "b" : "a" });
      process.stdout.write(`Test board running at http://127.0.0.1:${port}/ (layout ${layout})\n`);
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
