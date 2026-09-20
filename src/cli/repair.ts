import { repair } from "../compiler/index.js";
import { PilotStore } from "../pilots/store.js";
import { executePilot } from "../runtime/execute.js";
import { CapabilityRegistry } from "../capability/registry.js";
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
  const registry = new CapabilityRegistry(env);
  const capabilityDefinition = loaded.pilot.capability
    ? registry.get(loaded.pilot.capability)
    : null;

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
    baseSchema: capabilityDefinition?.schema,
    capabilitySchemaVersion: capabilityDefinition?.version,
    query: { keywords: flagString(args, "query") ?? "" },
    env,
    onProgress: (message) => process.stderr.write(`  ${message}\n`),
  });

  const dir = store.save(result.pilot, result.code, result.records.slice(0, 10));
  const promotion = result.pilot.capability
    ? registry.promoteFromPilots(
        result.pilot.capability,
        store.all().map((item) => item.pilot),
        { samples: store.samples() },
      )
    : null;
  process.stdout.write(
    `\nRepaired ${id}: ${loaded.pilot.version} → ${result.pilot.version} ` +
      `(${result.steps} steps, ${result.attempts} attempt(s))\n` +
      `  ${result.records.length} records extracted\n  ${dir}\n`,
  );
  const previousFields = new Set(loaded.pilot.schema.fields.map((field) => field.name));
  const addedFields = result.pilot.schema.fields.filter((field) => !previousFields.has(field.name));
  if (addedFields.length > 0) {
    process.stdout.write(`  added API fields: ${addedFields.map((field) => field.name).join(", ")}\n`);
  }
  if (promotion && promotion.promoted.length > 0) {
    process.stdout.write(
      `  promoted to ${result.pilot.capability}@schema-${promotion.definition.version}: ` +
        `${promotion.promoted.map((field) => field.name).join(", ")}\n`,
    );
  }
  if (promotion && promotion.blocked.length > 0) {
    for (const item of promotion.blocked) {
      process.stdout.write(`  kept site-local: ${item.field} — ${item.reason}\n`);
    }
  }
  return 0;
}
