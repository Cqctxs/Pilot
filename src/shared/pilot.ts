/**
 * A Pilot is one compiled, reusable integration: an extraction script plus the
 * evidence that it worked. Pilots are plain files under
 * `pilots/<id>/<version>/`, so they can be read, diffed, edited by hand, and
 * committed.
 *
 * The script is written once, by the compiler. Running it never calls a model.
 */
import { z } from "zod";
import { dataSchemaSchema, fieldSpecSchema } from "./schema.js";

export const PILOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const scriptArtifactSchema = z.strictObject({
  kind: z.literal("script"),
  /** File next to pilot.json exporting `search(page, query)`. */
  entry: z.string().regex(/^[a-z0-9._-]+\.m?js$/i),
  /**
   * Whether the script needs a rendered page. Scripts that only call JSON
   * endpoints skip launching Chromium entirely, which is much faster.
   */
  needsBrowser: z.boolean(),
});

export const pilotSchema = z.strictObject({
  pilotFormatVersion: z.literal(2),
  id: z.string().regex(PILOT_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  target: z.strictObject({
    name: z.string().min(1),
    url: z.string().url(),
  }),
  /** Capability this Pilot implements, or `null` for an ad-hoc extraction. */
  capability: z.string().nullable(),
  /** Shared capability schema revision this Pilot was compiled against. */
  capabilitySchemaVersion: z.string().regex(VERSION_PATTERN).nullable().default(null),
  /** The capability's schema, copied in so a Pilot is self-describing. */
  schema: dataSchemaSchema,
  /** Optional fields implemented by this Pilot on top of the shared schema. */
  schemaExtensions: z.array(fieldSpecSchema).default([]),
  artifact: scriptArtifactSchema,
  /**
   * Fields the explorer noticed but could not extract reliably enough to add to
   * this Pilot's schema. Reliably extracted optional fields are promoted into
   * `schema.fields` instead.
   */
  discovered: z.array(z.string()).default([]),
  origin: z.enum(["ai-generated", "handwritten"]),
  createdAt: z.string(),
  compiler: z
    .strictObject({
      model: z.string(),
      attempts: z.number().int().positive(),
      /** Tool calls the explorer spent on the site. */
      steps: z.number().int().nonnegative().default(0),
      repairedFrom: z.string().nullable().default(null),
      /**
       * Reference notes this compile was given, if any — e.g.
       * `browse.sh:indeed.com/search-jobs-8yxl6y`. Provenance: a script built
       * with a prior was not derived from this site alone, and a reader
       * deciding whether to trust it should be able to see that.
       */
      skillSource: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** What the compiler saw when it accepted this script. */
  evidence: z.strictObject({
    recordCount: z.number().int().nonnegative(),
    checkedAt: z.string(),
    sampleFile: z.string().nullable().default(null),
  }),
});

export type Pilot = z.infer<typeof pilotSchema>;
export type ScriptArtifact = z.infer<typeof scriptArtifactSchema>;

/** Runtime configuration for one Pilot: whether it runs, and with what arguments. */
export const pilotConfigSchema = z.strictObject({
  id: z.string().regex(PILOT_ID_PATTERN),
  enabled: z.boolean(),
  /** Extra values merged into the query the script receives. */
  variables: z.record(z.string(), z.string()).default({}),
});

export const pilotConfigFileSchema = z.strictObject({
  pilots: z.array(pilotConfigSchema),
});

export type PilotConfig = z.infer<typeof pilotConfigSchema>;
export type PilotConfigFile = z.infer<typeof pilotConfigFileSchema>;

export function parsePilot(input: unknown): Pilot {
  return pilotSchema.parse(input);
}
