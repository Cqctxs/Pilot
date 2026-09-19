import { pilot as createPilot } from "../sdk/index.js";
import { JOBS_CAPABILITY, type EmploymentType, type JobQuery } from "../capability/jobs.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";

const TYPES: EmploymentType[] = ["internship", "full-time", "part-time", "contract", "temporary"];

export async function runSearch(env: PilotEnv, args: ParsedArgs): Promise<number> {
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
    process.stdout.write(`${job.title}\n  ${job.company}${location}${type}\n  ${job.url}\n\n`);
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
