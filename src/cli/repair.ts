import { repair } from "../compiler/index.js";
import { PilotStore } from "../pilots/store.js";
import { executePilot } from "../runtime/execute.js";
import { toPilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";
import { flagString, type ParsedArgs } from "./args.js";

export async function runRepair(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write("Usage: pilot repair <id>\n");
    return 1;
  }

  const store = new PilotStore(env);
  const loaded = store.get(id);
  const previousCode = store.readScript(id);

  // Reproduce the failure first. Repairing a Pilot that still works would
  // replace a known-good script with an unproven one.
  let failure = flagString(args, "failure");
  if (!failure) {
    process.stderr.write("  reproducing the failure\n");
    try {
      const records = await executePilot(loaded);
      process.stdout.write(`${id} still works (${records.length} records). Nothing to repair.\n`);
      return 0;
    } catch (cause) {
      const error = toPilotError(cause);
      failure = `${error.code}: ${error.message}`;
      process.stderr.write(`  reproduced: ${failure}\n`);
    }
  }

  const result = await repair({
    pilot: loaded.pilot,
    previousCode,
    failure,
    query: { keywords: flagString(args, "query") ?? "" },
    env,
    onProgress: (message) => process.stderr.write(`  ${message}\n`),
  });

  const dir = store.save(result.pilot, result.code, result.records.slice(0, 10));
  process.stdout.write(
    `\nRepaired ${id}: ${loaded.pilot.version} → ${result.pilot.version} ` +
      `(${result.steps} steps, ${result.attempts} attempt(s))\n` +
      `  ${result.records.length} records extracted\n  ${dir}\n`,
  );
  return 0;
}
