/**
 * Registry documents.
 *
 * A published Pilot is the local artifact plus its script source and the
 * provenance needed to trust it. The whole thing is one MongoDB document
 * because that is what a Pilot already is: a JSON object whose `schema` varies
 * per capability. There is no relational shape to flatten it into, and adding a
 * capability must not mean adding a migration.
 */
import { z } from "zod";
import { pilotSchema, PILOT_ID_PATTERN, VERSION_PATTERN } from "../shared/pilot.js";
import { capabilityDefinitionSchema } from "../capability/registry.js";

/** One published version. `_id` is `<pilotId>@<version>`, so publishing twice is idempotent. */
export const registryEntrySchema = z.object({
  _id: z.string(),
  pilotId: z.string().regex(PILOT_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  capability: z.string().nullable(),
  /** Hostname of the target site — the axis people actually browse by. */
  host: z.string(),
  pilot: pilotSchema,
  /** The extraction script itself. A Pilot is worthless without it. */
  code: z.string(),
  sample: z.unknown().nullable().default(null),
  publisher: z.string(),
  publishedAt: z.string(),
  /** Denormalized for the text index: id, host, capability, discovered fields. */
  keywords: z.array(z.string()).default([]),
  summary: z.string(),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/**
 * One published revision of a capability definition.
 *
 * Publishing implementations without their interface is the drift the local
 * store cannot prevent: two machines both compiling against `hotels.search@1`
 * invent their own definition of it, and the `capabilitySchemaVersion` each
 * Pilot records then points at two different shapes. The interface travels
 * with the implementations, keyed by `<id>/<schema version>` so every
 * revision is fetchable and republishing one is idempotent.
 */
export const capabilityEntrySchema = z.object({
  _id: z.string(),
  capabilityId: z.string(),
  version: z.string().regex(VERSION_PATTERN),
  definition: capabilityDefinitionSchema,
  fieldNames: z.array(z.string()).default([]),
  publisher: z.string(),
  publishedAt: z.string(),
});

export type CapabilityEntry = z.infer<typeof capabilityEntrySchema>;

/**
 * One recorded run of a published Pilot.
 *
 * Events, not a counter: a rolling success rate is the signal that a site
 * changed under a Pilot, and you can only compute that from history. This is
 * what turns "someone noticed it broke" into "the registry knows it broke".
 */
export const healthEventSchema = z.object({
  pilotId: z.string(),
  version: z.string(),
  ok: z.boolean(),
  recordCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  errorCode: z.string().nullable().default(null),
  at: z.string(),
  reporter: z.string(),
});

export type HealthEvent = z.infer<typeof healthEventSchema>;

/** Aggregated health for one published version, worst first. */
export interface HealthSummary {
  pilotId: string;
  version: string;
  runs: number;
  successes: number;
  successRate: number;
  /**
   * Runs that reported success and returned nothing.
   *
   * The failure mode this exists for is the quiet one. A script whose selector
   * stopped matching, or that was served a block page, very often returns `[]`
   * rather than throwing — and `[]` is also what a genuine no-match looks like,
   * so the run is recorded as a success and the Pilot reads as perfectly
   * healthy while being completely dead. A success rate alone cannot see that.
   * A Pilot returning nothing on every run is either broken or useless, and
   * both are worth a look, so this is counted and sorted on.
   */
  emptyRuns: number;
  emptyRate: number;
  avgRecords: number;
  lastRunAt: string;
  lastError: string | null;
}
