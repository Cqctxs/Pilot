import { repair } from "../compiler/index.js";
import { PilotStore, type LoadedPilot } from "../pilots/store.js";
import { executePilot } from "../runtime/execute.js";
import { CapabilityRegistry } from "../capability/registry.js";
import { toPilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";
import type { RawRecord } from "../shared/schema.js";
import { flagString, type ParsedArgs } from "./args.js";

/**
 * Run a Pilot and decide whether it is broken. `null` means it still works.
 *
 * "Did not throw" is not the same as "works". The common way a script dies is
 * quietly: a selector stops matching, or a block page is served, and the
 * extraction returns `[]` — which is also exactly what a genuine no-match looks
 * like. Treating an empty result as proof of health is how a dead Pilot stays
 * dead, because `pilot repair` refuses to touch it and the health report shows
 * a perfect success rate. Someone asking to repair a Pilot that returns nothing
 * is telling us something, so the empty result is the reproduction.
 */
export async function reproduceFailure(
  loaded: LoadedPilot,
  keywords: string,
): Promise<string | null> {
  let records: RawRecord[];
  try {
    records = await executePilot(loaded, { query: { keywords } });
  } catch (cause) {
    const error = toPilotError(cause);
    return `${error.code}: ${error.message}`;
  }
  if (records.length > 0) return null;
  return (
    "The script ran without error and returned zero records. Either the site now returns " +
    "nothing for this query, or the extraction silently stopped matching — from the " +
    "outside those are indistinguishable, which is the problem. Work out which it is, " +
    "and make the replacement throw rather than return [] when the results container is " +
    "missing on the first page."
  );
}

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
    const reproduction = await reproduceFailure(loaded, flagString(args, "query") ?? "");
    if (reproduction === null) {
      process.stdout.write(`${id} still works. Nothing to repair.\n`);
      return 0;
    }
    failure = reproduction;
    process.stderr.write(`  reproduced: ${failure.split("\n")[0]}\n`);
  }

  const result = await repair({
    pilot: loaded.pilot,
    previousCode,
    failure,
    baseSchema: capabilityDefinition?.schema,
    capabilitySchemaVersion: capabilityDefinition?.version,
    query: { keywords: flagString(args, "query") ?? "" },
    headless: !args.flags.watch,
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
