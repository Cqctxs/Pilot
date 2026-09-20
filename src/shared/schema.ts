/**
 * A schema describes the shape of the data a Pilot extracts.
 *
 * It is the one thing the compiler is told up front and the one thing the
 * runtime guarantees on the way out. Capabilities provide the starting schema
 * (see `capability/jobs.ts`); a compiler may add validated optional fields for
 * one Pilot, while ad-hoc extractions define a schema from `--fields`.
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

export interface SchemaExtensionResult {
  schema: DataSchema;
  added: FieldSpec[];
  problems: string[];
}

/**
 * A single extracted record.
 *
 * Extraction yields strings — it reads text off a page — but the schema
 * declares what each field *is*, and the runtime coerces to that before any
 * caller sees the record. Without that step a field declared `number` arrives
 * as `"133"`, and the first thing anyone does with a set of prices is compare
 * them: `"143" < "9"` is true, so the cheapest result loses and the answer is
 * wrong with no error anywhere. The declared type is the whole point of
 * declaring it.
 */
export type RawValue = string | number | boolean | null;
export type RawRecord = Record<string, RawValue>;

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
  return dataSchemaSchema.parse({ name: "adhoc", fields });
}

/**
 * Validate fields proposed by the compiler model and merge them into the schema
 * it was originally given. Existing fields win: a proposal may repeat a
 * compatible field, but it may not silently change that field's type.
 *
 * A schema that arrives with no fields at all is a *draft capability* — nobody
 * has declared this interface yet and the model is being asked to design it. In
 * that case, and only that case, a proposal may mark itself required.
 */
export function extendDataSchema(schema: DataSchema, input: unknown): SchemaExtensionResult {
  const allowRequired = schema.fields.length === 0;
  if (input === undefined) return { schema, added: [], problems: [] };
  if (!Array.isArray(input)) {
    return { schema, added: [], problems: ["additionalFields must be an array"] };
  }
  if (input.length > 20) {
    return {
      schema,
      added: [],
      problems: ["additionalFields may contain at most 20 fields"],
    };
  }

  const fields = [...schema.fields];
  const byName = new Map(fields.map((field) => [field.name, field]));
  const added: FieldSpec[] = [];
  const problems: string[] = [];

  for (const [index, candidate] of input.entries()) {
    if (!candidate || typeof candidate !== "object") {
      problems.push(`additionalFields[${index}] must be an object`);
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const parsed = fieldSpecSchema.safeParse({
      name: value.name,
      type: value.type,
      // Additions to an existing capability are always optional: every other
      // Pilot already implements that interface without this field, and a new
      // requirement would retroactively break them. A draft capability has no
      // implementations yet, so there the model decides what identifies a
      // record — and a schema with nothing required asserts nothing.
      required: allowRequired ? value.required === true : false,
      description: value.description,
    });
    if (!parsed.success) {
      const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
      problems.push(`additionalFields[${index}] is invalid: ${reason}`);
      continue;
    }

    const existing = byName.get(parsed.data.name);
    if (existing) {
      if (existing.type !== parsed.data.type) {
        problems.push(
          `Field "${parsed.data.name}" already exists as ${existing.type}; it cannot be changed to ${parsed.data.type}`,
        );
      }
      continue;
    }

    fields.push(parsed.data);
    added.push(parsed.data);
    byName.set(parsed.data.name, parsed.data);
  }

  return {
    schema: { ...schema, fields },
    added,
    problems,
  };
}

/** Fields for which a validation sample contains no non-null value. */
export function fieldsWithoutValues(records: RawRecord[], fields: FieldSpec[]): string[] {
  return fields
    .filter(
      (field) =>
        !records.some(
          (record) => record[field.name] !== null && record[field.name] !== undefined,
        ),
    )
    .map((field) => field.name);
}

/**
 * The text of a value, for code that reads a record as prose.
 *
 * Records carry declared types now, so a field may already be a number or a
 * boolean by the time anything reads it. Anywhere that wants to trim it, match
 * it or display it wants its text — and wants that to be explicit rather than
 * an implicit coercion that turns `null` into `"null"`.
 */
export function asText(value: RawValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
