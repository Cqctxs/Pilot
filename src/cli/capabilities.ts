import { existsSync, readFileSync } from "node:fs";
import { CapabilityRegistry, type CapabilityDefinition } from "../capability/registry.js";
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

  if (subcommand === "add") return add(env, registry, rest[0], args);
  if (subcommand === "rm") return remove(env, registry, rest[0], args);
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

async function add(
  env: PilotEnv,
  registry: CapabilityRegistry,
  id: string | undefined,
  args: ParsedArgs,
): Promise<number> {
  if (!id) {
    process.stderr.write(
      "Usage: pilot capabilities add <id> --describe <text>\n" +
        "       pilot capabilities add <id> --url <url> [--describe <text>]\n" +
        "       pilot capabilities add <id> --fields <a,b,c>\n" +
        "       pilot capabilities add <id> --from <file.json>\n",
    );
    return 1;
  }
  const from = flagString(args, "from");
  const fields = flagString(args, "fields");
  const describe = flagString(args, "describe");
  const url = flagString(args, "url");
  if (!from && !fields && !describe && !url) {
    process.stderr.write("pilot capabilities add needs --describe, --url, --fields or --from\n");
    return 1;
  }

  let schema: DataSchema;
  let rationale: string | null = null;
  if (describe || url) {
    // The only path here that costs a model call, so say so before spending it.
    const { capturePage, designCapability } = await import("../compiler/design.js");
    // A page is an example, not the specification — it grounds the names and
    // units in what these sites really publish, while the description (when
    // there is one) says which of the things on that page you actually want.
    let evidence = null;
    if (url) {
      process.stderr.write(`  reading ${url}\n`);
      evidence = await capturePage(url);
    }
    process.stderr.write(
      `  designing ${id} from ${[describe ? "your description" : null, url ? "the page" : null]
        .filter(Boolean)
        .join(" and ")}\n`,
    );
    const designed = await designCapability({ id, description: describe ?? "", evidence, env });
    schema = dataSchemaSchema.parse({ name: id, fields: designed.fields });
    rationale = designed.rationale;
  } else if (from) {
    schema = schemaFromFile(from, id);
  } else {
    schema = dataSchemaSchema.parse({ name: id, fields: parseCapabilityFields(fields!) });
  }

  // Proposed, not saved. A capability's shape is a contract every future Pilot
  // compiles against, so a generated one is worth reading before it becomes one.
  if (args.flags["dry-run"] === true) {
    // Repeat back the invocation that produced this, so "keep it" and "edit it"
    // are the same design rather than a second, differently-worded one.
    const origin =
      [describe ? `--describe ${JSON.stringify(describe)}` : null, url ? `--url ${url}` : null]
        .filter(Boolean)
        .join(" ") || (from ? `--from ${from}` : `--fields ${JSON.stringify(fields)}`);
    // JSON rather than a --fields string: generated descriptions are full
    // sentences and routinely contain commas, which the --fields DSL splits on.
    // A file is also the thing you would want to edit before committing to it.
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      `Proposed ${id} (nothing written)\n` +
        schema.fields
          .map((field) => `  ${field.name}${field.required ? "*" : ""} (${field.type}): ${field.description}\n`)
          .join("") +
        (rationale ? `\n  ${rationale}\n` : "") +
        `\nKeep it:     pilot capabilities add ${id} ${origin}\n` +
        `Edit first:  pilot capabilities add ${id} ${origin} --dry-run --json > ${id}.json\n` +
        `             pilot capabilities add ${id} --from ${id}.json\n`,
    );
    return 0;
  }

  const definition = registry.define(id, schema);
  const overlap = describeOverlap(registry, definition);
  process.stdout.write(
    `Declared ${definition.id} at schema ${definition.version}\n` +
      definition.schema.fields
        .map((field) => `  ${field.name}${field.required ? "*" : ""} (${field.type}): ${field.description}\n`)
        .join("") +
      (rationale ? `\n  ${rationale}\n` : "") +
      (overlap ? `\n${overlap}\n` : "") +
      `\nCompile against it:  pilot create <url> --capability ${definition.id}\n`,
  );
  return 0;
}


/**
 * Say so when a new capability looks like one that already exists.
 *
 * Two ids with the same shape are two standards for one thing, and the second
 * one is usually a mistake — most often a value baked into a name, like a
 * hotels capability for a single city when the city belongs in the query. This
 * only reports; merging someone's contract is not the registry's call, and a
 * genuine near-twin (flights vs trains) is a normal thing to declare.
 */
function describeOverlap(
  registry: CapabilityRegistry,
  declared: CapabilityDefinition,
): string | null {
  const mine = new Set(declared.schema.fields.map((field) => field.name));
  const lines: string[] = [];
  for (const other of registry.all()) {
    if (other.id === declared.id) continue;
    const theirs = new Set(other.schema.fields.map((field) => field.name));
    const shared = [...mine].filter((name) => theirs.has(name));
    if (shared.length === 0) continue;
    const union = new Set([...mine, ...theirs]).size;
    const overlap = shared.length / union;
    if (mine.size <= theirs.size && shared.length === mine.size) {
      lines.push(`  Every field of ${declared.id} already exists in ${other.id}.`);
    } else if (overlap >= 0.6) {
      lines.push(
        `  ${declared.id} and ${other.id} share ${shared.length} of ${union} fields.`,
      );
    }
  }
  if (lines.length === 0) return null;
  return (
    `${lines.join("\n")}\n` +
    `  If these are the same function type, prefer the existing one — a value like\n` +
    `  a city or a date belongs in the query, not in a second capability.`
  );
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

/**
 * Forget an interface.
 *
 * Refused while Pilots still implement it, because a Pilot whose capability
 * has no definition cannot be validated, cannot be fanned out with its
 * siblings, and cannot say what its `capabilitySchemaVersion` refers to — it
 * would keep running and keep returning records, which is the failure mode
 * this codebase is least willing to ship. `--force` is there for a definition
 * declared by mistake, before anything implemented it.
 */
async function remove(
  env: PilotEnv,
  registry: CapabilityRegistry,
  id: string | undefined,
  args: ParsedArgs,
): Promise<number> {
  if (!id) {
    process.stderr.write("Usage: pilot rm <capability>\n");
    return 1;
  }
  const definition = registry.get(id);
  const { PilotStore } = await import("../pilots/store.js");
  const { canonicalCapability } = await import("../capability/registry.js");
  const implementers = new PilotStore(env)
    .all()
    .filter((item) => canonicalCapability(item.pilot.capability) === definition.id)
    .map((item) => item.pilot.id);

  if (implementers.length > 0 && !args.flags.force) {
    process.stderr.write(
      `${definition.id} is implemented by ${implementers.join(", ")}.\n` +
        `  Remove those Pilots first, or pass --force to leave them without an interface.\n`,
    );
    return 1;
  }
  registry.remove(definition.id);
  process.stdout.write(
    `Removed ${definition.id}\n` +
      (implementers.length > 0
        ? `  ${implementers.join(", ")} now implement an interface that is not defined here.\n`
        : ""),
  );
  return 0;
}
