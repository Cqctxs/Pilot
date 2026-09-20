import { compile } from "../compiler/index.js";
import { PilotStore } from "../pilots/store.js";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../capability/jobs.js";
import { CapabilityRegistry } from "../capability/registry.js";
import { parseFieldList, type DataSchema } from "../shared/schema.js";
import { PILOT_ID_PATTERN } from "../shared/pilot.js";
import { toPilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";
import { Registry, withRegistry } from "../registry/client.js";
import { installPilotPackage } from "./packages.js";

/** `indeed.com` → `indeed`, `www.talent.com` → `talent`. */
function deriveId(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".").filter((part) => part !== "co" && part !== "com");
  const candidate = (parts.at(-1) === "io" || parts.length === 1 ? parts[0] : parts.at(-2) ?? parts[0])!;
  return candidate.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export async function runCreate(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const url = args.positional[0];
  if (!url) {
    process.stderr.write("Usage: pilot create <url> [--id <name>] [--fields <a,b,c>]\n");
    return 1;
  }

  const fields = flagString(args, "fields");
  const capabilityFlag = flagString(args, "capability");
  let capability: string | null;
  let schema: DataSchema;
  let capabilitySchemaVersion: string | undefined;
  let newCapability = false;
  const registry = new CapabilityRegistry(env);

  if (fields) {
    const seed = parseFieldList(fields);
    if (capabilityFlag) {
      capability = capabilityFlag;
      const definition = registry.find(capability);
      schema = definition?.schema ?? { ...seed, name: capability };
      capabilitySchemaVersion = definition?.version;
      newCapability = definition === null;
    } else {
      capability = null;
      schema = seed;
    }
  } else {
    capability = capabilityFlag ?? JOBS_CAPABILITY;
    const definition = registry.find(capability);
    if (definition) {
      schema = definition.schema;
      capabilitySchemaVersion = definition.version;
    } else if (capability === JOBS_CAPABILITY) {
      schema = JOBS_SCHEMA;
      newCapability = true;
    } else {
      // An empty draft is valid only inside the compiler. The submitted script
      // must propose real fields, and the persisted schema still requires one.
      schema = { name: capability, fields: [] };
      newCapability = true;
    }
  }

  const requestedId = flagString(args, "id");
  const id = requestedId ?? deriveId(url);
  if (!PILOT_ID_PATTERN.test(id)) {
    process.stderr.write(`Invalid Pilot id "${id}". Use lowercase letters, digits and dashes.\n`);
    return 1;
  }

  // Reuse before compiling. A Pilot for this capability that already covers
  // this host is the same artifact a compile would produce, minus the model
  // call — checked locally first, then in the registry. `--compile` forces a
  // fresh one, and so does `--from-skill`: asking to compile from specific
  // notes is an instruction about how to compile, not a request we can no-op.
  const skillRef = flagString(args, "from-skill");
  const store = new PilotStore(env);
  if (!fields && capability && args.flags.compile !== true && !skillRef) {
    const local = store.all().find(
      (item) =>
        item.pilot.id === id &&
        item.pilot.capability === capability &&
        new URL(item.pilot.target.url).hostname.replace(/^www\./, "") ===
          new URL(url).hostname.replace(/^www\./, ""),
    );
    if (local) {
      process.stdout.write(
        `Using installed ${local.pilot.id}@${local.pilot.version} for ${capability}; no model call.\n`,
      );
      return 0;
    }

    if (Registry.isConfigured(env)) {
      // Best-effort. Looking for something to reuse is an optimization, and an
      // optimization that cannot run is not a reason to refuse the work: a
      // configured-but-unreachable registry must degrade to compiling, not
      // take `pilot create` down with it.
      const candidates = await withRegistry(env, (remote) =>
        remote.compatible(url, capability!),
      ).catch((cause: unknown) => {
        const error = toPilotError(cause);
        process.stderr.write(`  registry unavailable (${error.code}); compiling instead\n`);
        return [] as Awaited<ReturnType<Registry["compatible"]>>;
      });
      const existing = candidates.find((entry) => entry.pilotId === id) ??
        (requestedId ? undefined : candidates[0]);
      if (existing) {
        const installed = await installPilotPackage(env, existing.pilotId, existing.version);
        new PilotStore(env).setEnabled(installed.entry.pilotId, true);
        process.stdout.write(
          `Installed existing ${installed.entry._id} from the registry for ${capability}; no model call.\n` +
            `  ${installed.entry.summary}\n` +
            `  ${installed.dir}\n\n` +
            `Try it:  pilot search ${installed.entry.pilotId}\n`,
        );
        return 0;
      }
    }
  }

  // Prior knowledge, when the caller has some. Fetched before the browser
  // opens so a bad reference fails in a second rather than mid-compile.
  let notes = null;
  if (skillRef) {
    const { fetchSkillNotes } = await import("../compiler/skills.js");
    notes = await fetchSkillNotes(skillRef);
    process.stderr.write(`  reference notes: ${notes.source} (${notes.markdown.length} bytes)\n`);
  }

  const result = await compile({
    url,
    notes,
    id,
    name: flagString(args, "name"),
    capability,
    schema,
    capabilitySchemaVersion,
    query: {
      keywords: flagString(args, "query") ?? "",
      location: flagString(args, "location") ?? "",
    },
    maxAttempts: flagNumber(args, "attempts"),
    maxSteps: flagNumber(args, "steps"),
    // `--watch` shows the browser, which is the fastest way to see why a
    // compile is going wrong on a site that fights back.
    headless: !args.flags.watch,
    env,
    onProgress: (message) => process.stderr.write(`  ${message}\n`),
  });

  if (newCapability && capability) {
    const definition = registry.ensure(capability, result.pilot.schema);
    result.pilot.capabilitySchemaVersion = definition.version;
    result.pilot.schemaExtensions = [];
  }

  const dir = store.save(result.pilot, result.code, result.records.slice(0, 10));
  store.setEnabled(id, true);
  const promotion = capability
    ? registry.promoteFromPilots(
        capability,
        store.all().map((item) => item.pilot),
        { samples: store.samples() },
      )
    : null;

  const transport = result.pilot.artifact.needsBrowser ? "browser" : "http";
  process.stdout.write(
    `\nCompiled ${id}@${result.pilot.version} (${transport}, ${result.steps} steps, ${result.attempts} attempt(s))\n` +
      `  ${result.records.length} records extracted\n` +
      `  ${dir}\n`,
  );
  const startingFields = new Set(schema.fields.map((field) => field.name));
  const addedFields = result.pilot.schema.fields.filter((field) => !startingFields.has(field.name));
  if (addedFields.length > 0) {
    process.stdout.write(`  added API fields: ${addedFields.map((field) => field.name).join(", ")}\n`);
  }
  if (result.pilot.discovered.length > 0) {
    process.stdout.write(`  noticed but not promoted: ${result.pilot.discovered.join(", ")}\n`);
  }
  if (promotion && promotion.promoted.length > 0) {
    process.stdout.write(
      `  promoted to ${capability}@schema-${promotion.definition.version}: ` +
        `${promotion.promoted.map((field) => field.name).join(", ")}\n`,
    );
  }
  if (promotion && promotion.blocked.length > 0) {
    for (const item of promotion.blocked) {
      process.stdout.write(`  kept site-local: ${item.field} — ${item.reason}\n`);
    }
  }
  process.stdout.write(`\nTry it:  pilot search ${id}\n`);
  return 0;
}
