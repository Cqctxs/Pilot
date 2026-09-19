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
  avgRecords: number;
  lastRunAt: string;
  lastError: string | null;
}
