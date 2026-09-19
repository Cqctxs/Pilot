/**
 * The compiler: a URL goes in, a tested Pilot comes out.
 *
 *   observe → generate → validate → (retry with the failure) → save
 *
 * The retry loop is the important part. A single model call that produces
 * plausible-looking JSON is not a compiler; a loop that refuses to emit a Pilot
 * until it has pulled real records off the real site is.
 */
import { parseRecipe, type Recipe } from "../shared/recipe.js";
import type { DataSchema, RawRecord } from "../shared/schema.js";
import type { Pilot } from "../shared/pilot.js";
import { pilotError } from "../shared/errors.js";
import { loadEnv, type PilotEnv } from "../shared/env.js";
import { observe, type Observation } from "./observe.js";
import { createModelClient, type ModelClient } from "./model.js";
import { buildRepairPrompt, buildRetryPrompt, buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { validateRecipe } from "./validate.js";

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface CompileOptions {
  url: string;
  id: string;
  name?: string;
  capability: string | null;
  schema: DataSchema;
  /** Sample query used while validating, so the recipe is tested the way it will be used. */
  variables?: Record<string, string | number>;
  maxAttempts?: number;
  env?: PilotEnv;
  onProgress?: (message: string) => void;
}

export interface CompileResult {
  pilot: Pilot;
  records: RawRecord[];
  attempts: number;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const env = options.env ?? loadEnv();
  const model = createModelClient(env);
  const progress = options.onProgress ?? (() => {});

  progress(`observing ${options.url}`);
  const observation = await observe(options.url);
  progress(
    observation.json.length > 0
      ? `found ${observation.json.length} JSON endpoint(s)`
      : "no JSON endpoints; compiling against the DOM",
  );

  const { recipe, records, attempts } = await generateUntilValid({
    model,
    schema: options.schema,
    variables: options.variables ?? {},
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    firstPrompt: buildUserPrompt(options.schema, observation),
    progress,
  });

  const now = new Date().toISOString();
  const pilot: Pilot = {
    pilotFormatVersion: 1,
    id: options.id,
    version: "1.0.0",
    target: { name: options.name ?? new URL(options.url).hostname, url: options.url },
    capability: options.capability,
    schema: options.schema,
    recipe,
    origin: "ai-generated",
    createdAt: now,
    compiler: { model: model.model, attempts, repairedFrom: null },
    evidence: { recordCount: records.length, checkedAt: now, sampleFile: "sample.json" },
  };

  return { pilot, records, attempts };
}

/**
 * Recompile a Pilot whose recipe stopped matching the site. Same loop, but the
 * model is shown what used to work and how it failed.
 */
export async function repair(options: {
  pilot: Pilot;
  failure: string;
  variables?: Record<string, string | number>;
  maxAttempts?: number;
  env?: PilotEnv;
  onProgress?: (message: string) => void;
}): Promise<CompileResult> {
  const env = options.env ?? loadEnv();
  const model = createModelClient(env);
  const progress = options.onProgress ?? (() => {});

  progress(`re-observing ${options.pilot.target.url}`);
  const observation: Observation = await observe(options.pilot.target.url);

  const { recipe, records, attempts } = await generateUntilValid({
    model,
    schema: options.pilot.schema,
    variables: options.variables ?? {},
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    firstPrompt: `${buildRepairPrompt(JSON.stringify(options.pilot.recipe, null, 2), options.failure)}

${buildUserPrompt(options.pilot.schema, observation)}`,
    progress,
  });

  const now = new Date().toISOString();
  const [major, minor] = options.pilot.version.split(".").map(Number);
  const pilot: Pilot = {
    ...options.pilot,
    version: `${major}.${(minor ?? 0) + 1}.0`,
    recipe,
    origin: "ai-generated",
    createdAt: now,
    compiler: { model: model.model, attempts, repairedFrom: options.pilot.version },
    evidence: { recordCount: records.length, checkedAt: now, sampleFile: "sample.json" },
  };

  return { pilot, records, attempts };
}

async function generateUntilValid(input: {
  model: ModelClient;
  schema: DataSchema;
  variables: Record<string, string | number>;
  maxAttempts: number;
  firstPrompt: string;
  progress: (message: string) => void;
}): Promise<{ recipe: Recipe; records: RawRecord[]; attempts: number }> {
  const expectedFields = input.schema.fields.map((field) => field.name);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: input.firstPrompt },
  ];
  const failures: string[] = [];

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    input.progress(`generating recipe (attempt ${attempt}/${input.maxAttempts})`);
    const raw = await input.model.complete(SYSTEM_PROMPT, messages);

    let recipe: Recipe;
    try {
      recipe = parseRecipe(JSON.parse(raw), expectedFields);
    } catch (cause) {
      // Shape errors are cheap to catch and cheap to explain, so they never
      // cost a network round trip against the target site.
      const problem = (cause as Error).message;
      failures.push(`attempt ${attempt}: ${problem}`);
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: buildRetryPrompt(raw, problem) });
      continue;
    }

    input.progress(`validating ${recipe.kind} recipe against the live site`);
    const report = await validateRecipe(recipe, input.schema, input.variables);
    if (report.ok) {
      input.progress(`validated: ${report.records.length} records`);
      return { recipe, records: report.records, attempts: attempt };
    }

    const problem = report.problems.join("\n");
    failures.push(`attempt ${attempt}: ${problem}`);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: buildRetryPrompt(raw, problem) });
  }

  throw pilotError(
    "VALIDATION_FAILED",
    `Could not compile a working recipe in ${input.maxAttempts} attempts:\n${failures.join("\n")}`,
  );
}
