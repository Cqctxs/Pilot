import { compile } from "../compiler/index.js";
import { PilotStore } from "../pilots/store.js";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../capability/jobs.js";
import {
  CapabilityRegistry,
  type CapabilityDefinition,
} from "../capability/registry.js";
import { parseFieldList, type DataSchema } from "../shared/schema.js";
import { PILOT_ID_PATTERN } from "../shared/pilot.js";
import { toPilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";
import { Registry, withRegistry } from "../registry/client.js";
import type { CapabilityEntry, RegistryEntry } from "../registry/types.js";
import { installPilotPackage } from "./packages.js";
import {
  apiIntegrationFor,
  apiReferenceNotes,
  combineReferenceNotes,
  credentialValues,
} from "../integrations/apis.js";

/** `indeed.com` → `indeed`, `www.talent.com` → `talent`. */
function deriveId(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".").filter((part) => part !== "co" && part !== "com");
  const candidate = (parts.at(-1) === "io" || parts.length === 1 ? parts[0] : parts.at(-2) ?? parts[0])!;
  return candidate.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function normalizedTarget(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${pathname}`;
}

function mergeCapabilityCatalog(
  local: readonly CapabilityDefinition[],
  remote: readonly CapabilityEntry[],
): CapabilityDefinition[] {
  // The project's installed contract wins over a registry revision. Replacing
  // it silently would change what existing application code means.
  const definitions = new Map(local.map((definition) => [definition.id, definition]));
  for (const entry of remote) {
    if (!definitions.has(entry.capabilityId)) {
      definitions.set(entry.capabilityId, entry.definition);
    }
  }
  return [...definitions.values()];
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
  let automaticallyDesignedCapability = false;
  let selectedRemoteCapability: CapabilityDefinition | null = null;
  const registry = new CapabilityRegistry(env);

  if (fields) {
    const seed = parseFieldList(fields);
    if (capabilityFlag) {
      capability = registry.resolve(capabilityFlag);
      const definition = registry.find(capability);
      schema = definition?.schema ?? { ...seed, name: capability };
      capabilitySchemaVersion = definition?.version;
      newCapability = definition === null;
    } else {
      capability = null;
      schema = seed;
    }
  } else if (capabilityFlag) {
    capability = registry.resolve(capabilityFlag);
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
  } else {
    // Filled after the cheap exact-site reuse checks below. A bare URL no
    // longer means jobs.search: the page and the shared catalog decide.
    capability = null;
    schema = { name: "pending", fields: [] };
  }

  const requestedId = flagString(args, "id");
  const id = requestedId ?? deriveId(url);
  if (!PILOT_ID_PATTERN.test(id)) {
    process.stderr.write(`Invalid Pilot id "${id}". Use lowercase letters, digits and dashes.\n`);
    return 1;
  }
  const apiIntegration = apiIntegrationFor(url);
  let apiCredentials: Record<string, string> | null = null;

  // Reuse before compiling. A Pilot for this capability that already covers
  // this host is the same artifact a compile would produce, minus the model
  // call — checked locally first, then in the registry. `--compile` forces a
  // fresh one, and so does `--from-skill`: asking to compile from specific
  // notes is an instruction about how to compile, not a request we can no-op.
  const skillRef = flagString(args, "from-skill");
  const store = new PilotStore(env);
  const automaticCapability = !fields && !capabilityFlag;

  // With no interface pinned, an exact URL is the strongest possible answer:
  // this script has already been compiled for this page. Reuse it before
  // opening a browser or calling the model.
  if (automaticCapability && args.flags.compile !== true && !skillRef) {
    const target = normalizedTarget(url);
    const local = store.all().find(
      (item) =>
        item.pilot.capability !== null &&
        (!requestedId || item.pilot.id === requestedId) &&
        normalizedTarget(item.pilot.target.url) === target,
    );
    if (local) {
      process.stdout.write(
        `Using installed ${local.pilot.id}@${local.pilot.version} for ` +
          `${local.pilot.capability}; no model call.\n`,
      );
      return 0;
    }
  }

  let remoteHostPilots: RegistryEntry[] = [];
  let remoteCapabilities: CapabilityEntry[] = [];
  let registryLookupAttempted = false;
  let registryAvailable = false;
  if (automaticCapability && Registry.isConfigured(env) && args.flags.compile !== true && !skillRef) {
    registryLookupAttempted = true;
    const remote = await withRegistry(env, async (client) => ({
      pilots: await client.compatible(url),
      capabilities: await client.listCapabilities(),
    })).catch((cause: unknown) => {
      const error = toPilotError(cause);
      process.stderr.write(`  registry unavailable (${error.code}); compiling instead\n`);
      return null;
    });
    if (remote) {
      registryAvailable = true;
      remoteHostPilots = remote.pilots;
      remoteCapabilities = remote.capabilities;
    }

    const target = normalizedTarget(url);
    const exact = remoteHostPilots.find(
      (entry) =>
        entry.pilot.capability !== null &&
        normalizedTarget(entry.pilot.target.url) === target &&
        (!requestedId || entry.pilotId === requestedId),
    );
    if (exact) {
      const installed = await installPilotPackage(env, exact.pilotId, exact.version);
      new PilotStore(env).setEnabled(installed.entry.pilotId, true);
      process.stdout.write(
        `Installed existing ${installed.entry._id} from the registry for ` +
          `${installed.entry.capability}; no model call.\n` +
          `  ${installed.entry.summary}\n` +
          `  ${installed.dir}\n\n` +
          `Try it:  pilot search ${installed.entry.pilotId}\n`,
      );
      return 0;
    }
  }

  // Missing official-API credentials are actionable without a model call.
  // Exact local/registry reuse was allowed first because an existing Pilot may
  // not need the newly catalogued API at all.
  if (automaticCapability && apiIntegration) {
    apiCredentials = credentialValues(apiIntegration.credentials, env);
  }

  if (automaticCapability) {
    const { capturePage, selectCapability } = await import("../compiler/design.js");
    process.stderr.write(`  reading ${url} to choose a capability\n`);
    const evidence = await capturePage(url);

    // When --compile is used we still consult the shared interfaces; the flag
    // asks for a fresh script, not a duplicate contract. Fetch the catalog now
    // if the reuse pass above intentionally did not.
    if (Registry.isConfigured(env) && !registryLookupAttempted) {
      registryLookupAttempted = true;
      const found = await withRegistry(env, (client) => client.listCapabilities()).catch(
        (cause: unknown) => {
          const error = toPilotError(cause);
          process.stderr.write(`  registry unavailable (${error.code}); using local capabilities\n`);
          return null;
        },
      );
      if (found) {
        registryAvailable = true;
        remoteCapabilities = found;
      }
    }

    const localCapabilities = registry.all();
    const catalog = mergeCapabilityCatalog(localCapabilities, remoteCapabilities);
    process.stderr.write(
      `  choosing from ${catalog.length} shared capabilit${catalog.length === 1 ? "y" : "ies"}\n`,
    );
    const selected = await selectCapability({ evidence, candidates: catalog, env });
    if (selected.action === "use_existing") {
      capability = selected.definition.id;
      schema = selected.definition.schema;
      capabilitySchemaVersion = selected.definition.version;
      if (!registry.find(capability)) selectedRemoteCapability = selected.definition;
      process.stderr.write(
        `  using ${capability}${selected.rationale ? ` — ${selected.rationale}` : ""}\n`,
      );
    } else {
      capability = selected.id;
      schema = { name: capability, fields: selected.fields };
      newCapability = true;
      automaticallyDesignedCapability = true;
      process.stderr.write(
        `  creating ${capability}${selected.rationale ? ` — ${selected.rationale}` : ""}\n`,
      );
    }

    // The page did not exactly match a published target, but after selecting an
    // interface a same-host implementation may still be reusable (for example,
    // the stored target included a query string or a neighboring catalog path).
    if (args.flags.compile !== true && !skillRef && registryAvailable) {
      const compatible = remoteHostPilots.length > 0
        ? remoteHostPilots.filter(
            (entry) => entry.capability === capability,
          )
        : await withRegistry(env, (client) => client.compatible(url, capability)).catch(
            () => [] as RegistryEntry[],
          );
      const existing = compatible.find((entry) => entry.pilotId === id) ??
        (requestedId ? undefined : compatible[0]);
      if (existing) {
        const installed = await installPilotPackage(env, existing.pilotId, existing.version);
        new PilotStore(env).setEnabled(installed.entry.pilotId, true);
        process.stdout.write(
          `Installed existing ${installed.entry._id} from the registry for ${capability}; ` +
            `no compile model call.\n` +
            `  ${installed.entry.summary}\n` +
            `  ${installed.dir}\n\n` +
            `Try it:  pilot search ${installed.entry.pilotId}\n`,
        );
        return 0;
      }
    }
  }

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
  apiCredentials ??= apiIntegration
    ? credentialValues(apiIntegration.credentials, env)
    : {};
  let notes = null;
  if (skillRef) {
    const { fetchSkillNotes } = await import("../compiler/skills.js");
    notes = await fetchSkillNotes(skillRef);
    process.stderr.write(`  reference notes: ${notes.source} (${notes.markdown.length} bytes)\n`);
  } else {
    process.stderr.write(`  checking browse.sh for prior site knowledge\n`);
    try {
      const { findSkillNotesForUrl } = await import("../compiler/skills.js");
      notes = await findSkillNotesForUrl(url, capability);
      process.stderr.write(
        notes
          ? `  reference notes: ${notes.source} (${notes.markdown.length} bytes, automatic)\n`
          : `  no unambiguous browse.sh skill; exploring directly\n`,
      );
    } catch (cause) {
      const error = toPilotError(cause);
      process.stderr.write(`  browse.sh unavailable (${error.code}); exploring directly\n`);
    }
  }
  if (apiIntegration) {
    notes = combineReferenceNotes(notes, apiReferenceNotes(apiIntegration));
    process.stderr.write(
      `  official API: ${apiIntegration.name} (${apiIntegration.credentials.length === 0 ? "no key required" : `credentials from ${apiIntegration.credentials.map((item) => item.env).join(", ")}`})\n`,
    );
  }

  const result = await compile({
    url,
    notes,
    id,
    name: flagString(args, "name"),
    capability,
    schema,
    capabilitySchemaVersion,
    credentials: apiIntegration?.credentials ?? [],
    requireHttp: apiIntegration !== null,
    query: {
      keywords: flagString(args, "query") ?? "",
      location: flagString(args, "location") ?? "",
      ...apiCredentials,
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
    const definition = registry.ensure(
      capability,
      automaticallyDesignedCapability ? schema : result.pilot.schema,
    );
    result.pilot.capabilitySchemaVersion = definition.version;
    if (!automaticallyDesignedCapability) result.pilot.schemaExtensions = [];
  } else if (selectedRemoteCapability) {
    registry.save(selectedRemoteCapability);
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
