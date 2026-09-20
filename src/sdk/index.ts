/**
 * The developer-facing API.
 *
 *   const jobs = pilot().capability("jobs.search@1");
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
import { CapabilityRegistry } from "../capability/registry.js";
import type { RawRecord } from "../shared/schema.js";
import type { ScriptQuery } from "../runtime/script.js";
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
  /** Union of fields supported by the selected Pilot schemas. */
  fields: string[];
}

export type GenericFilterValue = string | number | boolean;

export interface GenericQuery {
  /** Scalar values handed to the generated script, e.g. destination or checkIn. */
  params?: Record<string, string | number | boolean | null>;
  /** Exact-match local filters over the unified output fields. */
  filters?: Record<string, GenericFilterValue | GenericFilterValue[]>;
  limit?: number;
}

/**
 * Record shapes for the capabilities installed here, filled in by `pilot types`.
 *
 * Empty by design: this package cannot know what interfaces a project has
 * installed, but the project does. The generated declaration file augments this
 * interface, and every capability id in it starts returning its real fields
 * instead of `RawRecord`. Without that file nothing breaks — an unaugmented
 * lookup falls through to the untyped overload, which is exactly today's
 * behaviour.
 */
export interface CapabilityTypes {}

export interface CapabilityRecord<T = RawRecord> {
  source: string;
  values: T;
}

export interface GenericSearchResult<T = RawRecord> {
  records: CapabilityRecord<T>[];
  sources: SourceResult[];
  fields: string[];
}

export interface CapabilityTarget {
  id: string;
  name: string;
  enabled: boolean;
  version: string;
  schemaVersion: string | null;
  fields: string[];
}

export interface JobsCapability {
  search(...args: Array<string | JobQuery>): Promise<SearchResult>;
  /** Which Pilots this capability can currently reach. */
  targets(): CapabilityTarget[];
}

export interface GenericCapability<T = RawRecord> {
  search(...args: Array<string | GenericQuery>): Promise<GenericSearchResult<T>>;
  targets(): CapabilityTarget[];
}

export interface Pilot {
  capability(id: typeof JOBS_CAPABILITY | "jobs.search"): JobsCapability;
  /** A capability `pilot types` has generated a shape for. */
  capability<K extends Extract<keyof CapabilityTypes, string>>(
    id: K,
  ): GenericCapability<CapabilityTypes[K]>;
  capability(id: string): GenericCapability;
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

/**
 * Round-robin the per-source results instead of concatenating them.
 *
 * Concatenation makes the fan-out invisible to anyone who takes a prefix. A
 * caller doing `jobs.slice(0, 5)` — or paginating, or rendering the first
 * screenful — gets every record from whichever Pilot happens to be first in
 * the store, and a four-source search looks like a one-source search. The
 * per-source counts say otherwise, but the data the caller actually reads does
 * not. Interleaving makes a prefix a sample of the whole search, which is what
 * asking several boards at once is for.
 */
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      if (index < group.length) out.push(group[index]!);
    }
  }
  return out;
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
            schemaVersion: item.pilot.capabilitySchemaVersion,
            fields: item.pilot.schema.fields.map((field) => field.name),
          }));
      },

      async search(...args: Array<string | JobQuery>): Promise<SearchResult> {
        const { targets, query } = splitArgs(args);
        const selected = resolveCapabilityTargets(store, targets, JOBS_CAPABILITY);

        // Fan out concurrently; a slow board should not serialize the rest.
        const settled = await Promise.all(selected.map((item) => runOne(item, query)));

        // Interleaved before deduping, so a cross-listed posting is credited to
        // whichever source came back with it first in round-robin order.
        const jobs = dedupeJobs(interleave(settled.map((entry) => entry.jobs)));
        const fields = [
          ...new Set(selected.flatMap((item) => item.pilot.schema.fields.map((field) => field.name))),
        ];
        return { jobs, sources: settled.map((entry) => entry.result), fields };
      },
    };
  }

  async function runOne(
    item: LoadedPilot,
    query: JobQuery,
  ): Promise<{ jobs: Job[]; result: SourceResult }> {
    const started = Date.now();
    try {
      const records = await executePilot(item, {
        query: {
          keywords: query.keywords ?? "",
          location: query.location ?? "",
          limit: query.limit ?? null,
        },
      });

      // Sites interpret a query however they like, so filter every result set
      // locally. That is what makes two boards comparable.
      let jobs = filterJobs(
        records
          .map((record) => toJob(item.pilot.id, record, item.pilot.schema))
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

  function genericCapability(id: string): GenericCapability {
    return {
      targets() {
        return store
          .all()
          .filter((item) => item.pilot.capability === id)
          .map((item) => ({
            id: item.pilot.id,
            name: item.pilot.target.name,
            enabled: item.config.enabled,
            version: item.pilot.version,
            schemaVersion: item.pilot.capabilitySchemaVersion,
            fields: item.pilot.schema.fields.map((field) => field.name),
          }));
      },

      async search(...args: Array<string | GenericQuery>): Promise<GenericSearchResult> {
        const { targets, query } = splitGenericArgs(args);
        const selected = resolveCapabilityTargets(store, targets, id);
        const settled = await Promise.all(selected.map((item) => runGeneric(item, query)));
        const records = interleave(settled.map((entry) => entry.records));
        const fields = [
          ...new Set(selected.flatMap((item) => item.pilot.schema.fields.map((field) => field.name))),
        ];
        return { records, sources: settled.map((entry) => entry.result), fields };
      },
    };
  }

  async function runGeneric(
    item: LoadedPilot,
    query: GenericQuery,
  ): Promise<{ records: CapabilityRecord[]; result: SourceResult }> {
    const started = Date.now();
    try {
      const scriptQuery: Partial<ScriptQuery> = { ...query.params, limit: query.limit ?? null };
      let raw = await executePilot(item, { query: scriptQuery });
      if (query.filters) {
        raw = raw.filter((record) => matchesGenericFilters(record, query.filters!));
      }
      if (query.limit !== undefined) raw = raw.slice(0, query.limit);
      const records = raw.map((values) => ({ source: item.pilot.id, values }));
      return {
        records,
        result: {
          pilotId: item.pilot.id,
          ok: true,
          count: records.length,
          durationMs: Date.now() - started,
        },
      };
    } catch (cause) {
      return {
        records: [],
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

  function capability(id: typeof JOBS_CAPABILITY | "jobs.search"): JobsCapability;
  function capability(id: string): GenericCapability;
  function capability(id: string): JobsCapability | GenericCapability {
    // One resolution, here, so everything downstream compares full ids: the
    // short name the caller typed becomes the installed major.
    const resolved = new CapabilityRegistry(env).resolve(id);
    if (resolved === JOBS_CAPABILITY) return jobsCapability();
    return genericCapability(resolved);
  }

  return {
    store,
    capability,
  };
}

function splitGenericArgs(
  args: Array<string | GenericQuery>,
): { targets: string[]; query: GenericQuery } {
  const targets: string[] = [];
  let query: GenericQuery = {};
  for (const arg of args) {
    if (typeof arg === "string") targets.push(arg);
    else if (arg && typeof arg === "object") query = { ...query, ...arg };
    else throw pilotError("INVALID_ARGUMENT", `search() takes Pilot names and an optional query object`);
  }
  return { targets, query };
}

function resolveCapabilityTargets(
  store: PilotStore,
  ids: readonly string[],
  capability: string,
): LoadedPilot[] {
  const selected = ids.length === 0
    ? store.enabled().filter((item) => item.pilot.capability === capability)
    : [...new Set(ids)].map((id) => store.get(id));
  const wrong = selected.find((item) => item.pilot.capability !== capability);
  if (wrong) {
    throw pilotError(
      "INVALID_ARGUMENT",
      `Pilot "${wrong.pilot.id}" implements ${wrong.pilot.capability ?? "an ad-hoc schema"}, not ${capability}`,
      { pilotId: wrong.pilot.id },
    );
  }
  if (selected.length === 0) {
    throw pilotError("NO_PILOTS_ENABLED", `No enabled Pilots implement ${capability}.`);
  }
  return selected;
}

function matchesGenericFilters(
  record: RawRecord,
  filters: NonNullable<GenericQuery["filters"]>,
): boolean {
  return Object.entries(filters).every(([field, requested]) => {
    const actual = record[field];
    if (actual === null || actual === undefined) return false;
    const values = Array.isArray(requested) ? requested : [requested];
    return values.some((value) => normalizeGeneric(actual) === normalizeGeneric(value));
  });
}

function normalizeGeneric(value: GenericFilterValue): string {
  return String(value).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export type {
  Job,
  JobAttributeValue,
  JobFilterValue,
  JobQuery,
} from "../capability/jobs.js";
export type { PilotError } from "../shared/errors.js";
