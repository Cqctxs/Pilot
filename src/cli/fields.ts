import { CapabilityRegistry, type CapabilityDefinition } from "../capability/registry.js";
import { describeFields, type CapabilityFields } from "../capability/fields.js";
import { PilotStore } from "../pilots/store.js";
import type { PilotEnv } from "../shared/env.js";
import type { ParsedArgs } from "./args.js";

/**
 * `pilot fields [targets...]` — what the selected Pilots can actually return.
 *
 * Same selection rule as `pilot search`: no names means every enabled Pilot, so
 * the default output describes exactly the result set an unqualified search
 * would produce.
 */
export async function runFields(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const store = new PilotStore(env);
  const registry = new CapabilityRegistry(env);
  const pilots = store.resolve(args.positional).map((item) => item.pilot);

  const definitions = new Map<string, CapabilityDefinition>();
  for (const pilot of pilots) {
    if (!pilot.capability || definitions.has(pilot.capability)) continue;
    const found = registry.find(pilot.capability);
    if (found) definitions.set(pilot.capability, found);
  }

  const groups = describeFields(pilots, definitions, store.samples());
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(groups.map(render).join("\n"));
  return 0;
}

function render(group: CapabilityFields): string {
  const heading = group.capability
    ? `${group.capability}  schema ${group.schemaVersion ?? "unregistered"}`
    : "ad-hoc Pilots (no shared capability)";
  const lines = [
    `${heading}`,
    `${group.pilots.length} Pilot${group.pilots.length === 1 ? "" : "s"}: ${group.pilots.join(", ")}`,
    "",
  ];

  const rows = group.fields.map((field) => [
    field.name + (field.required ? "*" : ""),
    field.type,
    `${field.available}/${field.total}`,
    field.measured === 0 ? "-" : `${field.populated}/${field.measured}`,
    field.tier,
    field.available === field.total ? "all" : field.providedBy.join(", "),
  ]);
  const headers = ["FIELD", "TYPE", "DECLARED", "FILLED", "TIER", "FROM"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ")}`.trimEnd();

  lines.push(line(headers));
  for (const row of rows) lines.push(line(row));

  const sparse = group.fields.filter((field) => field.available < field.total);
  const hollow = group.fields.filter((field) => field.measured > 0 && field.populated === 0);
  lines.push("");
  lines.push("  * required · DECLARED = Pilots carrying the field · FILLED = Pilots whose");
  lines.push("  samples actually had a value · core = the capability contract · shared = added");
  lines.push("  to it by promotion · local = this source only");
  if (sparse.length > 0) {
    lines.push(
      `  Not on every source, so null for the rest: ${sparse.map((field) => field.name).join(", ")}`,
    );
  }
  if (hollow.length > 0) {
    lines.push(
      `  Declared but empty in every sample — treat as unavailable: ` +
        `${hollow.map((field) => field.name).join(", ")}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
