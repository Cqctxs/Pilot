/**
 * A Pilot is one compiled, reusable integration: a recipe plus the evidence
 * that it worked. Pilots are plain files under `pilots/<id>/<version>/`, so
 * they can be read, diffed, and committed.
 */
import { z } from "zod";
import { dataSchemaSchema } from "./schema.js";
import { recipeSchema } from "./recipe.js";

export const PILOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const pilotSchema = z.strictObject({
  pilotFormatVersion: z.literal(1),
  id: z.string().regex(PILOT_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  target: z.strictObject({
    name: z.string().min(1),
    url: z.string().url(),
  }),
  /** Capability this Pilot implements, or `null` for an ad-hoc extraction. */
  capability: z.string().nullable(),
  /** The capability's schema, copied in so a Pilot is self-describing. */
  schema: dataSchemaSchema,
  recipe: recipeSchema,
  origin: z.enum(["ai-generated", "handwritten"]),
  createdAt: z.string(),
  compiler: z
    .strictObject({
      model: z.string(),
      attempts: z.number().int().positive(),
      repairedFrom: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** What the compiler saw when it accepted this recipe. */
  evidence: z.strictObject({
    recordCount: z.number().int().nonnegative(),
    checkedAt: z.string(),
    sampleFile: z.string().nullable().default(null),
  }),
});

export type Pilot = z.infer<typeof pilotSchema>;

/** Runtime configuration for one Pilot: whether it runs, and with what arguments. */
export const pilotConfigSchema = z.strictObject({
  id: z.string().regex(PILOT_ID_PATTERN),
  enabled: z.boolean(),
  /** Values bound into the recipe's URL template, e.g. a board tenant slug. */
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
