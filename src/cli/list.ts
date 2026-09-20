import { PilotStore } from "../pilots/store.js";
import {
  CapabilityRegistry,
  CAPABILITY_ID_PATTERN,
  CAPABILITY_NAME_PATTERN,
} from "../capability/registry.js";
import { pilotError } from "../shared/errors.js";
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
    // A capability id always carries an @version, and a Pilot id never can, so
    // anything else here is a guess at a command rather than an argument.
    // Without this check `pilot list capabilities` searched the registry for a
    // function type named "capabilities", found none, and printed "Nothing
    // found." — a confident answer to a question nobody asked.
    // A capability id carries a dot or an @version; a Pilot id can carry
    // neither, and neither can a mistyped command. That leaves one gap — a
    // dotless capability such as `jobs@1` must be written with its version
    // here — which is a better trade than reading `pilot list capabilities`
    // as a lookup for a function type named "capabilities".
    const looksLikeCapability =
      CAPABILITY_ID_PATTERN.test(capability) ||
      (CAPABILITY_NAME_PATTERN.test(capability) && capability.includes("."));
    if (!looksLikeCapability) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `"${capability}" is not a capability id — those look like jobs.search@1.\n` +
          `  Capabilities on this machine:  pilot capabilities\n` +
          `  Pilots on this machine:        pilot list\n` +
          `  Published Pilots for a type:   pilot list jobs.search@1`,
      );
    }
    // Published documents are keyed by the full id, so expand a short name (and
    // any renamed one) before asking the registry about it.
    const id = new CapabilityRegistry(env).resolve(capability);
    const entries = await withRegistry(env, (registry) => registry.list(id));
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

/**
 * What this machine can do, in one screen.
 *
 * Splitting Pilots and capabilities across two commands hid the relationship
 * that matters — a capability with no implementations is a declared interface
 * waiting for `pilot create`, and a Pilot is only useful through the interface
 * it implements. Bare `pilot ls` answers "what have I got", which is the
 * question people actually arrive with.
 */
export function runOverview(env: PilotEnv, args: ParsedArgs): number {
  const pilots = new PilotStore(env).all();
  const capabilities = new CapabilityRegistry(env).all();

  if (args.flags.json) {
    process.stdout.write(
      `${JSON.stringify({ capabilities, pilots: pilots.map((item) => item.pilot) }, null, 2)}\n`,
    );
    return 0;
  }

  if (capabilities.length === 0 && pilots.length === 0) {
    process.stdout.write(
      "Nothing installed yet.\n\n" +
        "  Compile a site:      pilot create <url>\n" +
        "  Declare an interface: pilot create jobs.search --describe \"open roles\"\n",
    );
    return 0;
  }

  for (const capability of capabilities) {
    const implementers = pilots.filter(
      (item) =>
        item.pilot.capability === capability.id,
    );
    process.stdout.write(
      `${capability.id}  ${capability.schema.fields.map((field) => field.name).join(", ")}\n`,
    );
    if (implementers.length === 0) {
      process.stdout.write(`    (no Pilots yet — pilot create <url> --capability ${capability.id})\n`);
    }
    for (const { pilot, config } of implementers) {
      process.stdout.write(
        `    ${pilot.id.padEnd(14)} ${pilot.version.padEnd(7)} ` +
          `${(config.enabled ? "enabled" : "disabled").padEnd(8)} ` +
          `${pilot.artifact.needsBrowser ? "browser" : "http"}\n`,
      );
    }
  }

  // A Pilot compiled with ad-hoc --fields belongs to no interface. It still
  // runs; it just cannot be part of a fan-out, which is worth showing.
  const looseOnes = pilots.filter((item) => !item.pilot.capability);
  if (looseOnes.length > 0) {
    process.stdout.write(`\nad-hoc (no capability)\n`);
    for (const { pilot } of looseOnes) {
      process.stdout.write(`    ${pilot.id.padEnd(14)} ${pilot.version}\n`);
    }
  }
  return 0;
}
