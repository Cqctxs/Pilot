import { pilot as createPilot, type GenericQuery } from "../sdk/index.js";
import { JOBS_CAPABILITY, type EmploymentType, type JobQuery } from "../capability/jobs.js";
import { CapabilityRegistry, canonicalCapability } from "../capability/registry.js";
import type { PilotEnv } from "../shared/env.js";
import { pilotError } from "../shared/errors.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";
import { PilotStore } from "../pilots/store.js";
import { Registry } from "../registry/client.js";
import type { SearchResult } from "../sdk/index.js";

const TYPES: EmploymentType[] = ["internship", "full-time", "part-time", "contract", "temporary"];

export async function runSearch(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const capability = resolveSearchCapability(env, args);
  if (capability !== JOBS_CAPABILITY) {
    return runGenericSearch(env, args, capability);
  }

  const type = flagString(args, "type");
  if (type && !TYPES.includes(type as EmploymentType)) {
    process.stderr.write(`--type must be one of: ${TYPES.join(", ")}\n`);
    return 1;
  }

  const query: JobQuery = {
    keywords: flagString(args, "keywords"),
    location: flagString(args, "location"),
    type: type as EmploymentType | undefined,
    limit: flagNumber(args, "limit"),
    strictLocation: args.flags["strict-location"] === true,
  };

  const filter = flagString(args, "filter");
  if (filter) {
    try {
      query.filters = parseFilters(filter);
    } catch (cause) {
      process.stderr.write(`${(cause as Error).message}\n`);
      return 1;
    }
  }

  const jobs = createPilot(env).capability(JOBS_CAPABILITY);
  // Positional arguments are Pilot names; none means every enabled Pilot.
  const result = await jobs.search(...args.positional, query);

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await reportRuns(env, result, args);
    return result.sources.every((source) => source.ok) ? 0 : 1;
  }

  for (const job of result.jobs) {
    const location = job.location ? ` · ${job.location}` : "";
    const type = job.type === "unknown" ? "" : ` · ${job.type}`;
    const attributes = Object.entries(job.attributes).filter((entry) => entry[1] !== null);
    const generated = attributes.length > 0
      ? `\n  ${attributes.map(([name, value]) => `${name}=${String(value)}`).join(" · ")}`
      : "";
    process.stdout.write(`${job.title}\n  ${job.company}${location}${type}${generated}\n  ${job.url}\n\n`);
  }

  const failed = result.sources.filter((source) => !source.ok);
  process.stdout.write(
    `${result.jobs.length} job(s) from ${result.sources.length - failed.length}/${result.sources.length} source(s)\n`,
  );
  for (const source of failed) {
    process.stderr.write(`  ${source.pilotId}: ${source.error?.code} — ${source.error?.message}\n`);
  }
  await reportRuns(env, result, args);
  // A search that reached at least one source succeeded; a total failure did not.
  return failed.length === result.sources.length ? 1 : 0;
}

/**
 * An explicitly named Pilot already says which interface it implements, so
 * requiring the same information again as --capability is redundant. A bare
 * search keeps the jobs default because there is no target from which to infer.
 */
export function resolveSearchCapability(env: PilotEnv, args: ParsedArgs): string {
  const requested = flagString(args, "capability");
  if (requested) return new CapabilityRegistry(env).resolve(requested);
  if (args.positional.length === 0) return JOBS_CAPABILITY;

  const store = new PilotStore(env);
  const selected = [...new Set(args.positional)].map((id) => store.get(id).pilot);
  const adHoc = selected.find((pilot) => pilot.capability === null);
  if (adHoc) {
    throw pilotError(
      "INVALID_ARGUMENT",
      `Pilot "${adHoc.id}" has an ad-hoc schema rather than a shared capability.`,
      { pilotId: adHoc.id },
    );
  }
  const capabilities = [
    ...new Set(selected.map((pilot) => canonicalCapability(pilot.capability)!)),
  ];
  if (capabilities.length > 1) {
    throw pilotError(
      "INVALID_ARGUMENT",
      `The selected Pilots implement different capabilities (${capabilities.join(", ")}). ` +
        "Search one capability at a time, or pass --capability explicitly.",
    );
  }
  return capabilities[0]!;
}

function parseFilters(input: string): Record<string, string> {
  return parsePairs(input, "--filter");
}

function parsePairs(input: string, flag: string): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const part of input.split(",")) {
    const equals = part.indexOf("=");
    if (equals <= 0 || equals === part.length - 1) {
      throw new Error(`${flag} must use field=value pairs separated by commas`);
    }
    const name = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (!name || !value) throw new Error(`${flag} must use field=value pairs separated by commas`);
    filters[name] = value;
  }
  return filters;
}

/**
 * Tell the registry how each source behaved. Best-effort and opt-out: a search
 * must not slow down or fail because a database is unreachable.
 *
 * This is the feed behind `pilot registry health`. The registry finds out that
 * a site changed from the searches people are already running, rather than from
 * someone noticing and filing a bug.
 */
async function reportRuns(
  env: PilotEnv,
  result: Pick<SearchResult, "sources">,
  args: ParsedArgs,
): Promise<void> {
  if (args.flags["no-report"] === true) return;
  if (!Registry.isConfigured(env)) return;

  try {
    const store = new PilotStore(env);
    const registry = await Registry.connect(env);
    try {
      await Promise.all(
        result.sources.map((source) =>
          registry.report({
            pilotId: source.pilotId,
            version: store.get(source.pilotId).pilot.version,
            ok: source.ok,
            recordCount: source.count,
            durationMs: source.durationMs,
            errorCode: source.error?.code ?? null,
          }),
        ),
      );
    } finally {
      await registry.close();
    }
  } catch {
    // Telemetry is never worth a non-zero exit.
  }
}

async function runGenericSearch(
  env: PilotEnv,
  args: ParsedArgs,
  capability: string,
): Promise<number> {
  const filters = flagString(args, "filter");
  const params = flagString(args, "param");
  const query: GenericQuery = {
    params: {
      keywords: flagString(args, "keywords") ?? "",
      location: flagString(args, "location") ?? "",
    },
    limit: flagNumber(args, "limit"),
  };
  if (params) {
    try {
      query.params = { ...query.params, ...parsePairs(params, "--param") };
    } catch (cause) {
      process.stderr.write(`${(cause as Error).message}\n`);
      return 1;
    }
  }
  if (filters) {
    try {
      query.filters = parseFilters(filters);
    } catch (cause) {
      process.stderr.write(`${(cause as Error).message}\n`);
      return 1;
    }
  }

  const result = await createPilot(env).capability(capability).search(...args.positional, query);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const record of result.records) {
      process.stdout.write(`${record.source}\n  ${JSON.stringify(record.values)}\n\n`);
    }
    const failed = result.sources.filter((source) => !source.ok);
    process.stdout.write(
      `${result.records.length} record(s) from ${result.sources.length - failed.length}/${result.sources.length} source(s)\n`,
    );
    for (const source of failed) {
      process.stderr.write(`  ${source.pilotId}: ${source.error?.code} — ${source.error?.message}\n`);
    }
  }
  await reportRuns(env, result, args);
  return result.sources.every((source) => !source.ok) ? 1 : 0;
}
