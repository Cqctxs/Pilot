import { PilotStore } from "../pilots/store.js";
import type { PilotEnv } from "../shared/env.js";
import type { ParsedArgs } from "./args.js";

export async function runList(env: PilotEnv, args: ParsedArgs): Promise<number> {
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
  process.stdout.write(`${"ID".padEnd(width)}  VERSION  STATUS    KIND        RECORDS  TARGET\n`);
  for (const { pilot, config } of pilots) {
    process.stdout.write(
      `${pilot.id.padEnd(width)}  ${pilot.version.padEnd(7)}  ` +
        `${(config.enabled ? "enabled" : "disabled").padEnd(8)}  ` +
        `${pilot.recipe.kind.padEnd(10)}  ${String(pilot.evidence.recordCount).padStart(7)}  ${pilot.target.name}\n`,
    );
  }
  return 0;
}
