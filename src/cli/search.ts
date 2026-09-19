import { pilot as createPilot, type GenericQuery } from "../sdk/index.js";
import { JOBS_CAPABILITY, type EmploymentType, type JobQuery } from "../capability/jobs.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";

const TYPES: EmploymentType[] = ["internship", "full-time", "part-time", "contract", "temporary"];

export async function runSearch(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const capability = flagString(args, "capability");
  if (capability && capability !== JOBS_CAPABILITY && capability !== "jobs.board" && capability !== "jobs") {
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
  // A search that reached at least one source succeeded; a total failure did not.
  return failed.length === result.sources.length ? 1 : 0;
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
  return result.sources.every((source) => !source.ok) ? 1 : 0;
}
