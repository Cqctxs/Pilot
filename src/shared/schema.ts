/**
 * A schema describes the shape of the data a Pilot extracts.
 *
 * It is the one thing the compiler is told up front and the one thing the
 * runtime guarantees on the way out. Capabilities define a fixed schema
 * (see `capability/jobs.ts`); ad-hoc extractions define one inline from
 * `pilot create --fields`.
 */
import { z } from "zod";

export const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export const fieldSpecSchema = z.strictObject({
  name: z.string().regex(FIELD_NAME_PATTERN),
  /** Extraction always yields strings; `type` tells the runtime how to coerce. */
  type: z.enum(["string", "number", "boolean", "url"]),
  required: z.boolean(),
  /** Written into the compiler prompt. The better this reads, the better the recipe. */
  description: z.string().min(1),
});

export const dataSchemaSchema = z.strictObject({
  name: z.string().min(1),
  fields: z.array(fieldSpecSchema).min(1),
});

export type FieldSpec = z.infer<typeof fieldSpecSchema>;
export type DataSchema = z.infer<typeof dataSchemaSchema>;

/** A single extracted record, before capability-level normalization. */
export type RawRecord = Record<string, string | null>;

export function parseFieldList(input: string): DataSchema {
  const fields = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name): FieldSpec => ({
      name,
      type: name.toLowerCase().endsWith("url") ? "url" : "string",
      required: false,
      description: name,
    }));
  if (fields.length === 0) {
    throw new Error("--fields needs at least one field name");
  }
  return { name: "adhoc", fields };
}
