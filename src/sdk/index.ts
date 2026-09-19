/**
 * The developer-facing API.
 *
 *   const jobs = pilot().capability("jobs.board@1");
 *
 *   await jobs.search();                        // every enabled Pilot
 *   await jobs.search("indeed");                // just Indeed
 *   await jobs.search("indeed", "linkedin");    // both, merged
 *   await jobs.search("indeed", { keywords: "software intern" });
 *   await jobs.search({ keywords: "software intern" });  // all, filtered
 *
 * Target names are positional; an optional trailing object is the query. The
 * application never names a website's shape — only which sources to ask.
 */
import { PilotStore, type LoadedPilot } from "../pilots/store.js";
import { executePilot } from "../runtime/execute.js";
import { toPilotError, pilotError, type PilotError } from "../shared/errors.js";
import { loadEnv, type PilotEnv } from "../shared/env.js";
import {
  JOBS_CAPABILITY,
  dedupeJobs,
  filterJobs,
  toJob,
  type Job,
  type JobQuery,
} from "../capability/jobs.js";

/** Per-source outcome. One dead site does not fail the whole search. */
export interface SourceResult {
  pilotId: string;
  ok: boolean;
  count: number;
  durationMs: number;
  error?: PilotError;
}

export interface SearchResult {
  jobs: Job[];
  sources: SourceResult[];
}

export interface JobsCapability {
  search(...args: Array<string | JobQuery>): Promise<SearchResult>;
  /** Which Pilots this capability can currently reach. */
  targets(): Array<{ id: string; name: string; enabled: boolean; version: string }>;
}

export interface Pilot {
  capability(id: string): JobsCapability;
  store: PilotStore;
}

function splitArgs(args: Array<string | JobQuery>): { targets: string[]; query: JobQuery } {
  const targets: string[] = [];
  let query: JobQuery = {};
  for (const arg of args) {
    if (typeof arg === "string") {
      targets.push(arg);
    } else if (arg && typeof arg === "object") {
      query = { ...query, ...arg };
    } else {
      throw pilotError("INVALID_ARGUMENT", `search() takes Pilot names and an optional query object`);
    }
  }
  return { targets, query };
}

export function pilot(env: PilotEnv = loadEnv()): Pilot {
  const store = new PilotStore(env);

  function jobsCapability(): JobsCapability {
    return {
      targets() {
        return store
          .all()
          .filter((item) => item.pilot.capability === JOBS_CAPABILITY)
          .map((item) => ({
            id: item.pilot.id,
            name: item.pilot.target.name,
            enabled: item.config.enabled,
            version: item.pilot.version,
          }));
      },

      async search(...args: Array<string | JobQuery>): Promise<SearchResult> {
        const { targets, query } = splitArgs(args);
        const selected = store.resolve(targets);

        // Fan out concurrently; a slow board should not serialize the rest.
        const settled = await Promise.all(selected.map((item) => runOne(item, query)));

        const jobs = dedupeJobs(settled.flatMap((entry) => entry.jobs));
        return { jobs, sources: settled.map((entry) => entry.result) };
      },
    };
  }

  async function runOne(
    item: LoadedPilot,
    query: JobQuery,
  ): Promise<{ jobs: Job[]; result: SourceResult }> {
    const started = Date.now();
    try {
      const records = await executePilot(item.pilot, {
        variables: {
          ...item.config.variables,
          keywords: query.keywords ?? "",
          location: query.location ?? "",
        },
      });

      // Sites interpret a query however they like, so filter every result set
      // locally. That is what makes two boards comparable.
      let jobs = filterJobs(
        records
          .map((record) => toJob(item.pilot.id, record))
          .filter((job): job is Job => job !== null),
        query,
      );
      if (query.limit !== undefined) jobs = jobs.slice(0, query.limit);

      return {
        jobs,
        result: { pilotId: item.pilot.id, ok: true, count: jobs.length, durationMs: Date.now() - started },
      };
    } catch (cause) {
      return {
        jobs: [],
        result: {
          pilotId: item.pilot.id,
          ok: false,
          count: 0,
          durationMs: Date.now() - started,
          error: toPilotError(cause),
        },
      };
    }
  }

  return {
    store,
    capability(id: string): JobsCapability {
      if (id !== JOBS_CAPABILITY && id !== "jobs.board" && id !== "jobs") {
        throw pilotError("UNSUPPORTED_CAPABILITY", `Unknown capability: ${id}`);
      }
      return jobsCapability();
    },
  };
}

export type { Job, JobQuery } from "../capability/jobs.js";
export type { PilotError } from "../shared/errors.js";
