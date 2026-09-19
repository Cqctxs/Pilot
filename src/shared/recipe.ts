/**
 * A recipe is the compiler's output and the runtime's only input.
 *
 * It is declarative on purpose: the model writes one, then never runs again.
 * Every field here is interpreted by a deterministic interpreter in `runtime/`,
 * so a recipe can be reviewed, diffed, cached, and replayed.
 *
 * Nothing in this file names a specific website. Anything site-specific belongs
 * in the recipe values, never in the schema.
 */
import { z } from "zod";

const TEMPLATE_VARIABLE = /\{([a-z][a-zA-Z0-9]*)\}/g;
const PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$|^\[\d+\]$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Dotted access path into a JSON document: `data.results[0].title`. `$` is the root. */
function jsonPath(value: string, ctx: z.RefinementCtx): void {
  if (value === "$" || value === "") return;
  for (const segment of value.replace(/\[(\d+)\]/g, ".[$1]").split(".")) {
    if (segment === "") continue;
    if (!PATH_SEGMENT.test(segment) || UNSAFE_KEYS.has(segment)) {
      ctx.addIssue({ code: "custom", message: `invalid JSON path segment: ${segment}` });
      return;
    }
  }
  return;
}

export function templateVariables(template: string): string[] {
  return [...template.matchAll(TEMPLATE_VARIABLE)].map((match) => match[1]!);
}

// --- Locators (browser recipes) ------------------------------------------

export const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("css"), selector: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
]);

export type Locator = z.infer<typeof locatorSchema>;

// --- Request ---------------------------------------------------------------

export const requestSchema = z.strictObject({
  /** `https://example.com/search?q={keywords}&start={offset}` */
  urlTemplate: z.string().min(1),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.string().nullable().default(null),
});

export const paginationSchema = z.discriminatedUnion("kind", [
  /** Bump a numeric template variable: page=1,2,3 or offset=0,10,20. */
  z.strictObject({
    kind: z.literal("counter"),
    variable: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    start: z.number().int(),
    step: z.number().int().positive(),
    maxPages: z.number().int().positive().max(20),
  }),
  /** Follow a "next" link in the rendered page (browser recipes only). */
  z.strictObject({
    kind: z.literal("nextLink"),
    locator: locatorSchema,
    maxPages: z.number().int().positive().max(20),
  }),
]);

// --- Field extraction ------------------------------------------------------

/**
 * Several sources per field, tried in order. Real sites scatter one logical
 * value across shapes (`location` vs `locations[0].name`), and a recipe that
 * can express the fallback survives more of the site than one that cannot.
 */
export const jsonFieldSchema = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        path: z.string().superRefine(jsonPath),
        joinWith: z.string().max(4).optional(),
      }),
    )
    .min(1),
  allowMissing: z.boolean(),
});

export const domFieldSchema = z.strictObject({
  /** `null` reads the row element itself. */
  locator: locatorSchema.nullable(),
  source: z.enum(["text", "href", "src", "value", "attribute"]).default("text"),
  /** Required when `source` is `attribute`. */
  attribute: z.string().min(1).optional(),
  allowMissing: z.boolean(),
});

// --- Recipes ---------------------------------------------------------------

export const httpJsonRecipeSchema = z.strictObject({
  recipeFormatVersion: z.literal(1),
  kind: z.literal("http-json"),
  request: requestSchema,
  pagination: paginationSchema.nullable().default(null),
  /** Path to the array of records. `$` when the response is itself an array. */
  recordsPath: z.string().superRefine(jsonPath),
  fields: z.record(z.string(), jsonFieldSchema),
  /** Drop records where `path` matches `equals` (unlisted jobs, ads, promos). */
  exclude: z
    .array(
      z.strictObject({
        path: z.string().superRefine(jsonPath),
        equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    )
    .default([]),
});

export const browserRecipeSchema = z.strictObject({
  recipeFormatVersion: z.literal(1),
  kind: z.literal("browser"),
  request: z.strictObject({
    urlTemplate: z.string().min(1),
    /** Locator that must appear before extraction starts. */
    waitFor: locatorSchema.nullable().default(null),
    waitForTimeoutMs: z.number().int().positive().max(60_000).default(15_000),
  }),
  pagination: paginationSchema.nullable().default(null),
  /** Repeating element, one per record. */
  rows: locatorSchema,
  fields: z.record(z.string(), domFieldSchema),
  /** Locator whose presence means "zero results", not "extraction failed". */
  emptyState: locatorSchema.nullable().default(null),
});

export const recipeSchema = z.discriminatedUnion("kind", [
  httpJsonRecipeSchema,
  browserRecipeSchema,
]);

export type HttpJsonRecipe = z.infer<typeof httpJsonRecipeSchema>;
export type BrowserRecipe = z.infer<typeof browserRecipeSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Parse a recipe and check it against the schema it claims to satisfy: every
 * required field extracted, no fields invented. Catches most bad model output
 * before anything touches the network.
 */
export function parseRecipe(input: unknown, expectedFields: string[]): Recipe {
  const recipe = recipeSchema.parse(input);
  const produced = new Set(Object.keys(recipe.fields));
  const missing = expectedFields.filter((name) => !produced.has(name));
  if (missing.length > 0) {
    throw new Error(`recipe does not extract required fields: ${missing.join(", ")}`);
  }
  const unknown = [...produced].filter((name) => !expectedFields.includes(name));
  if (unknown.length > 0) {
    throw new Error(`recipe extracts fields outside the schema: ${unknown.join(", ")}`);
  }
  return recipe;
}
