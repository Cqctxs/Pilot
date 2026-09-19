import { pilot as createPilot } from "../sdk/index.js";
import { JOBS_CAPABILITY, type EmploymentType, type JobQuery } from "../capability/jobs.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";
import { PilotStore } from "../pilots/store.js";
import { Registry } from "../registry/client.js";
import type { SearchResult } from "../sdk/index.js";

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
    await reportRuns(env, result, args);
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
  await reportRuns(env, result, args);
  // A search that reached at least one source succeeded; a total failure did not.
  return failed.length === result.sources.length ? 1 : 0;
}

/**
 * Tell the registry how each source behaved. Best-effort and opt-out: a search
 * must not slow down or fail because a database is unreachable.
 *
 * This is the feed behind `pilot registry health`. The registry finds out that
 * a site changed from the searches people are already running, rather than from
 * someone noticing and filing a bug.
 */
async function reportRuns(env: PilotEnv, result: SearchResult, args: ParsedArgs): Promise<void> {
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
