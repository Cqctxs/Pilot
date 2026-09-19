import { CapabilityRegistry } from "../capability/registry.js";
import type { PilotEnv } from "../shared/env.js";
import type { ParsedArgs } from "./args.js";

export async function runCapabilities(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const capabilities = new CapabilityRegistry(env).all();
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(capabilities, null, 2)}\n`);
    return 0;
  }
  if (capabilities.length === 0) {
    process.stdout.write("No shared capabilities registered.\n");
    return 0;
  }
  for (const capability of capabilities) {
    const fields = capability.schema.fields.map((field) => field.name).join(", ");
    process.stdout.write(`${capability.id}  schema ${capability.version}\n  ${fields}\n`);
  }
  return 0;
}
