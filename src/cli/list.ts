import { PilotStore } from "../pilots/store.js";
import { withRegistry } from "../registry/client.js";
import type { PilotEnv } from "../shared/env.js";
import { flagString, type ParsedArgs } from "./args.js";
import { printRegistryTable } from "./registry.js";

export async function runList(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const capability = args.positional[0] ?? flagString(args, "capability");
  if (args.positional.length > 1) {
    process.stderr.write("Usage: pilot list [capability] [--json]\n");
    return 1;
  }

  // With a capability, `list` is package discovery: show every published
  // implementation of that shared function. Bare `list` remains the quick
  // inventory of what is already installed on this machine.
  if (capability) {
    const entries = await withRegistry(env, (registry) => registry.list(capability));
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      printRegistryTable(entries);
    }
    return 0;
  }

  const pilots = new PilotStore(env).all();

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(pilots.map((item) => item.pilot), null, 2)}\n`);
    return 0;
  }

  if (pilots.length === 0) {
    process.stdout.write("No Pilots installed. Compile one with `pilot create <url>`.\n");
    return 0;
  }

  const width = Math.max(...pilots.map((item) => item.pilot.id.length), 4);
  process.stdout.write(`${"ID".padEnd(width)}  VERSION  STATUS    TRANSPORT   RECORDS  TARGET\n`);
  for (const { pilot, config } of pilots) {
    process.stdout.write(
      `${pilot.id.padEnd(width)}  ${pilot.version.padEnd(7)}  ` +
        `${(config.enabled ? "enabled" : "disabled").padEnd(8)}  ` +
        `${(pilot.artifact.needsBrowser ? "browser" : "http").padEnd(10)}  ${String(pilot.evidence.recordCount).padStart(7)}  ${pilot.target.name}\n`,
    );
  }
  return 0;
}
