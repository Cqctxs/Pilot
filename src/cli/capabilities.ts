import { existsSync, readFileSync } from "node:fs";
import { CapabilityRegistry } from "../capability/registry.js";
import { dataSchemaSchema, fieldSpecSchema, type DataSchema, type FieldSpec } from "../shared/schema.js";
import type { PilotEnv } from "../shared/env.js";
import { pilotError } from "../shared/errors.js";
import { flagString, type ParsedArgs } from "./args.js";

/**
 * `<name>[:<type>][!][=<description>]`
 *
 * `!` marks a required field, which is also what makes it part of the
 * capability's core contract. The description is optional here and generated
 * from the name when absent, but it is written into every future compiler
 * prompt for this capability, so a real one is worth the typing — or use
 * `--from` for a file where each field is spelled out properly.
 */
const FIELD_PATTERN = /^([a-z][a-zA-Z0-9]*)(?::(string|number|boolean|url))?(!)?(?:=(.*))?$/;

export function parseCapabilityFields(input: string): FieldSpec[] {
  const fields = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item): FieldSpec => {
      const match = FIELD_PATTERN.exec(item);
      if (!match) {
        throw pilotError(
          "INVALID_ARGUMENT",
          `Cannot read field "${item}". Use name[:type][!][=description], ` +
            `e.g. url:url!=Link to the listing`,
        );
      }
      const [, name, type, required, description] = match;
      return fieldSpecSchema.parse({
        name,
        type: type ?? (name!.toLowerCase().endsWith("url") ? "url" : "string"),
        required: required === "!",
        description: description?.trim() || name,
      });
    });
  if (fields.length === 0) {
    throw pilotError("INVALID_ARGUMENT", "--fields needs at least one field");
  }
  return fields;
}

/** A capability file may be a full definition, a schema, or just the fields. */
function schemaFromFile(path: string, id: string): DataSchema {
  if (!existsSync(path)) throw pilotError("INVALID_ARGUMENT", `No such file: ${path}`);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const body = parsed as Record<string, unknown>;
  const fields = Array.isArray(parsed)
    ? parsed
    : Array.isArray(body.fields)
      ? body.fields
      : (body.schema as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) {
    throw pilotError(
      "INVALID_ARGUMENT",
      `${path} must be an array of fields, or an object with "fields", or a full capability definition.`,
    );
  }
  return dataSchemaSchema.parse({ name: id, fields });
}

export async function runCapabilities(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const [subcommand, ...rest] = args.positional;
  const registry = new CapabilityRegistry(env);

  if (subcommand === "add") return add(registry, rest[0], args);
  if (subcommand === "show") return show(registry, rest[0], args);
  if (subcommand === "publish") return publish(env, registry, rest[0]);
  if (subcommand === "install") return install(env, registry, rest[0], args);
  if (subcommand && subcommand !== "list") {
    process.stderr.write(`Unknown subcommand: capabilities ${subcommand}\n`);
    return 1;
  }
  return list(registry, args);
}

function list(registry: CapabilityRegistry, args: ParsedArgs): number {
  const capabilities = registry.all();
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(capabilities, null, 2)}\n`);
    return 0;
  }
  if (capabilities.length === 0) {
    process.stdout.write(
      "No shared capabilities registered.\n" +
        "Declare one with: pilot capabilities add <id> --fields <a,b,c>\n",
    );
    return 0;
  }
  for (const capability of capabilities) {
    const fields = capability.schema.fields.map((field) => field.name).join(", ");
    process.stdout.write(`${capability.id}  schema ${capability.version}\n  ${fields}\n`);
  }
  return 0;
}

function show(registry: CapabilityRegistry, id: string | undefined, args: ParsedArgs): number {
  if (!id) {
    process.stderr.write("Usage: pilot capabilities show <id>\n");
    return 1;
  }
  const definition = registry.get(id);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
    return 0;
  }
  const core = new Set(definition.coreFields);
  process.stdout.write(`${definition.id}  schema ${definition.version}\n`);
  for (const field of definition.schema.fields) {
    process.stdout.write(
      `  ${field.name}${field.required ? "*" : ""} (${field.type}, ` +
        `${core.has(field.name) ? "declared" : "promoted"}): ${field.description}\n`,
    );
  }
  return 0;
}

function add(registry: CapabilityRegistry, id: string | undefined, args: ParsedArgs): number {
  if (!id) {
    process.stderr.write(
      "Usage: pilot capabilities add <id> --fields <a,b,c>\n" +
        "       pilot capabilities add <id> --from <file.json>\n",
    );
    return 1;
  }
  const from = flagString(args, "from");
  const fields = flagString(args, "fields");
  if (!from && !fields) {
    process.stderr.write("pilot capabilities add needs --fields or --from\n");
    return 1;
  }

  const schema: DataSchema = from
    ? schemaFromFile(from, id)
    : dataSchemaSchema.parse({ name: id, fields: parseCapabilityFields(fields!) });

  const definition = registry.define(id, schema);
  process.stdout.write(
    `Declared ${definition.id} at schema ${definition.version}\n` +
      definition.schema.fields
        .map((field) => `  ${field.name}${field.required ? "*" : ""} (${field.type}): ${field.description}\n`)
        .join("") +
      `\nCompile against it:  pilot create <url> --capability ${definition.id}\n`,
  );
  return 0;
}

async function publish(
  env: PilotEnv,
  registry: CapabilityRegistry,
  id: string | undefined,
): Promise<number> {
  if (!id) {
    process.stderr.write("Usage: pilot capabilities publish <id>\n");
    return 1;
  }
  const definition = registry.get(id);
  const { withRegistry } = await import("../registry/client.js");
  const entry = await withRegistry(env, (remote) => remote.publishCapability(definition));
  process.stdout.write(
    `Published ${entry._id} to ${env.registryDb} as ${entry.publisher}\n` +
      `  ${entry.fieldNames.join(", ")}\n` +
      `  Use it anywhere with: pilot capabilities install ${entry.capabilityId}\n`,
  );
  return 0;
}

async function install(
  env: PilotEnv,
  registry: CapabilityRegistry,
  ref: string | undefined,
  args: ParsedArgs,
): Promise<number> {
  if (!ref) {
    process.stderr.write("Usage: pilot capabilities install <id>[/<schema version>]\n");
    return 1;
  }
  const slash = ref.lastIndexOf("/");
  const id = slash > 0 ? ref.slice(0, slash) : ref;
  const version = slash > 0 ? ref.slice(slash + 1) : undefined;

  const existing = registry.find(id);
  if (existing && !args.flags.force) {
    process.stderr.write(
      `${id} is already defined locally at schema ${existing.version}. ` +
        `Overwriting it would change what every local Pilot's capabilitySchemaVersion ` +
        `refers to — pass --force if that is what you want.\n`,
    );
    return 1;
  }

  const { withRegistry } = await import("../registry/client.js");
  const entry = await withRegistry(env, (remote) => remote.fetchCapability(id, version));
  const saved = registry.save(entry.definition);
  process.stdout.write(
    `Installed ${saved.id} at schema ${saved.version} from ${entry.publisher}\n` +
      `  ${saved.schema.fields.map((field) => field.name).join(", ")}\n`,
  );
  return 0;
}
