/**
 * The compiler: a URL goes in, a tested Pilot comes out.
 *
 *   explore (agentic) → submit script → validate against the live site → retry
 *
 * The model drives a real browser through a narrow tool surface, tests its
 * extraction in the page, and submits a script. That script is then run for
 * real. A Pilot is written only after a run produces records that satisfy the
 * schema — there is no path that produces an unvalidated Pilot.
 */
import { toolResult, type TranscriptItem } from "./model.js";
import {
  extendDataSchema,
  fieldsWithoutValues,
  type DataSchema,
  type RawRecord,
} from "../shared/schema.js";
import type { CredentialRequirement, Pilot } from "../shared/pilot.js";
import type { ScriptQuery } from "../runtime/script.js";
import { pilotError } from "../shared/errors.js";
import { loadEnv, type PilotEnv } from "../shared/env.js";
import { createModelClient, type ModelClient } from "./model.js";
import { openExplorer, type Explorer } from "./explorer.js";
import { EXPLORER_TOOLS } from "./tools.js";
import {
  buildRepairPrompt,
  buildRetryPrompt,
  buildTaskPrompt,
  systemPrompt,
  type PromptStyle,
} from "./prompts.js";
import { validateScript, type ProbeOutcome } from "./validate.js";
import type { SkillNotes } from "./skills.js";
import { apiIntegrationFor, apiReferenceNotes, credentialValues } from "../integrations/apis.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_STEPS = 30;

export interface CompileOptions {
  url: string;
  id: string;
  name?: string;
  capability: string | null;
  schema: DataSchema;
  /** Revision of the shared capability schema supplied to this compile. */
  capabilitySchemaVersion?: string;
  /** Query the script is tested with, so it is proven the way it will be used. */
  query?: Partial<ScriptQuery>;
  maxAttempts?: number;
  maxSteps?: number;
  headless?: boolean;
  /** Which system prompt to compile with. Defaults to the configured style. */
  promptStyle?: PromptStyle;
  /** Prior knowledge about the site, e.g. a browse.sh SKILL.md. */
  notes?: SkillNotes | null;
  /** Named environment values used by an official API. Values live in query, never here. */
  credentials?: readonly CredentialRequirement[];
  /** A reviewed official API exists; browser automation is not an acceptable artifact. */
  requireHttp?: boolean;
  env?: PilotEnv;
  onProgress?: (message: string) => void;
}

export interface CompileResult {
  pilot: Pilot;
  code: string;
  records: RawRecord[];
  attempts: number;
  steps: number;
}

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const env = options.env ?? loadEnv();
  const model = createModelClient(env);
  const progress = options.onProgress ?? (() => {});
  const query = buildQuery(options.query);

  const explorer = await openExplorer({ headless: options.headless ?? true });
  try {
    const session = await runSession({
      model,
      explorer,
      progress,
      schema: options.schema,
      pilotId: options.id,
      targetUrl: options.url,
      query,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      promptStyle: options.promptStyle,
      sensitiveQueryKeys: options.credentials?.map((item) => item.env) ?? [],
      requireHttp: options.requireHttp ?? false,
      firstPrompt: buildTaskPrompt({
        url: options.url,
        schema: options.schema,
        sampleQuery: describeQuery(query),
        notes: options.notes,
      }),
    });

    const now = new Date().toISOString();
    const pilot: Pilot = {
      pilotFormatVersion: 2,
      id: options.id,
      version: "1.0.0",
      target: { name: options.name ?? new URL(options.url).hostname, url: options.url },
      capability: options.capability,
      capabilitySchemaVersion: options.capability
        ? options.capabilitySchemaVersion ?? "1.0.0"
        : null,
      schema: session.schema,
      schemaExtensions: schemaDifference(options.schema, session.schema),
      artifact: {
        kind: "script",
        entry: "extract.mjs",
        needsBrowser: session.needsBrowser,
      },
      credentials: [...(options.credentials ?? [])],
      discovered: session.discovered,
      origin: "ai-generated",
      createdAt: now,
      compiler: {
        model: model.model,
        attempts: session.attempts,
        steps: session.steps,
        repairedFrom: null,
        skillSource: options.notes?.source ?? null,
      },
      evidence: {
        recordCount: session.records.length,
        checkedAt: now,
        sampleFile: "sample.json",
        probe: session.probe,
      },
    };

    return { pilot, code: session.code, records: session.records, attempts: session.attempts, steps: session.steps };
  } finally {
    await explorer.close();
  }
}

/**
 * Recompile a Pilot whose script stopped working. Same loop, but the model is
 * shown what used to work and how it failed.
 */
export async function repair(options: {
  pilot: Pilot;
  previousCode: string;
  failure: string;
  /** Latest shared schema; existing Pilot extensions are layered on top. */
  baseSchema?: DataSchema;
  capabilitySchemaVersion?: string;
  query?: Partial<ScriptQuery>;
  maxAttempts?: number;
  maxSteps?: number;
  promptStyle?: PromptStyle;
  env?: PilotEnv;
  onProgress?: (message: string) => void;
}): Promise<CompileResult> {
  const env = options.env ?? loadEnv();
  const model = createModelClient(env);
  const progress = options.onProgress ?? (() => {});
  const requirements = options.pilot.credentials ?? [];
  const query = buildQuery({ ...options.query, ...credentialValues(requirements, env) });
  const baseSchema = options.baseSchema ?? options.pilot.schema;
  const previousExtensions = schemaDifference(baseSchema, options.pilot.schema);
  const startingSchema = extendDataSchema(baseSchema, previousExtensions).schema;
  const apiIntegration = apiIntegrationFor(options.pilot.target.url);

  const explorer = await openExplorer();
  try {
    const session = await runSession({
      model,
      explorer,
      progress,
      schema: startingSchema,
      pilotId: options.pilot.id,
      targetUrl: options.pilot.target.url,
      query,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      promptStyle: options.promptStyle,
      sensitiveQueryKeys: requirements.map((item) => item.env),
      requireHttp: apiIntegration !== null,
      firstPrompt: `${buildRepairPrompt(options.previousCode, options.failure)}

${buildTaskPrompt({
  url: options.pilot.target.url,
  schema: startingSchema,
  sampleQuery: describeQuery(query),
  notes: apiIntegration ? apiReferenceNotes(apiIntegration) : null,
})}`,
    });

    const now = new Date().toISOString();
    const [major, minor] = options.pilot.version.split(".").map(Number);
    const pilot: Pilot = {
      ...options.pilot,
      version: `${major}.${(minor ?? 0) + 1}.0`,
      capabilitySchemaVersion: options.pilot.capability
        ? options.capabilitySchemaVersion ?? options.pilot.capabilitySchemaVersion ?? "1.0.0"
        : null,
      schema: session.schema,
      schemaExtensions: schemaDifference(baseSchema, session.schema),
      artifact: { ...options.pilot.artifact, needsBrowser: session.needsBrowser },
      discovered: session.discovered,
      origin: "ai-generated",
      createdAt: now,
      compiler: {
        model: model.model,
        attempts: session.attempts,
        steps: session.steps,
        repairedFrom: options.pilot.version,
        skillSource: options.pilot.compiler?.skillSource ?? null,
      },
      evidence: {
        recordCount: session.records.length,
        checkedAt: now,
        sampleFile: "sample.json",
        probe: session.probe,
      },
    };

    return { pilot, code: session.code, records: session.records, attempts: session.attempts, steps: session.steps };
  } finally {
    await explorer.close();
  }
}

interface SessionResult {
  code: string;
  /** Which query keys the accepted script was shown to read. */
  probe: ProbeOutcome;
  needsBrowser: boolean;
  schema: DataSchema;
  discovered: string[];
  records: RawRecord[];
  attempts: number;
  steps: number;
}

/**
 * One exploration session. The model keeps the browser across retries, so a
 * rejected script is corrected with the site still open in front of it rather
 * than from a cold start.
 */
async function runSession(input: {
  model: ModelClient;
  explorer: Explorer;
  progress: (message: string) => void;
  schema: DataSchema;
  pilotId: string;
  targetUrl: string;
  query: ScriptQuery;
  maxAttempts: number;
  maxSteps: number;
  firstPrompt: string;
  promptStyle?: PromptStyle;
  sensitiveQueryKeys?: readonly string[];
  requireHttp: boolean;
}): Promise<SessionResult> {
  const messages: TranscriptItem[] = [
    { role: "system", content: systemPrompt(input.promptStyle) },
    { role: "user", content: input.firstPrompt },
  ];

  let steps = 0;
  let attempts = 0;
  const rejected: string[] = [];

  while (steps < input.maxSteps) {
    const turn = await input.model.turn(messages, EXPLORER_TOOLS);
    // Verbatim, reasoning items included: replaying them is what lets the model
    // continue a line of thought across turns rather than restart it.
    messages.push(...turn.raw);

    if (turn.toolCalls.length === 0) {
      // No tool call and no script: nudge once rather than ending the session.
      messages.push({
        role: "user",
        content: "Keep going. Use the tools to explore, then call submit_script.",
      });
      steps += 1;
      continue;
    }

    for (const call of turn.toolCalls) {
      steps += 1;

      if (call.name === "submit_script") {
        attempts += 1;
        const code = String(call.args.code ?? "");
        const needsBrowser = call.args.needsBrowser !== false;
        const discovered = Array.isArray(call.args.discoveredFields)
          ? call.args.discoveredFields.map(String)
          : [];
        const extension = extendDataSchema(input.schema, call.args.additionalFields);
        if (call.args.notes) input.progress(`model: ${String(call.args.notes)}`);
        input.progress(`validating submitted script (attempt ${attempts}/${input.maxAttempts})`);

        if (input.requireHttp && needsBrowser) {
          extension.problems.push(
            "This site has a reviewed official API. Submit a direct fetch-based script with needsBrowser=false instead of browser automation.",
          );
        }
        const report = extension.problems.length > 0
          ? { ok: false, records: [], problems: extension.problems, probe: { ran: false, readKeys: [], unreadKeys: [] } }
          : await validateScript({
              code,
              needsBrowser,
              schema: extension.schema,
              pilotId: input.pilotId,
              targetUrl: input.targetUrl,
              query: input.query,
              sensitiveQueryKeys: input.sensitiveQueryKeys,
              onLog: (message) => input.progress(`  ${message}`),
            });

        if (report.ok && extension.added.length > 0) {
          const missing = fieldsWithoutValues(report.records, extension.added);
          if (missing.length > 0) {
            report.ok = false;
            report.problems.push(
              `Proposed additional field(s) were not extracted from any record: ${missing.join(", ")}`,
            );
          }
        }

        if (report.ok) {
          if (extension.added.length > 0) {
            input.progress(`added fields: ${extension.added.map((field) => field.name).join(", ")}`);
          }
          input.progress(`validated: ${report.records.length} records`);
          return {
            code,
            needsBrowser,
            schema: extension.schema,
            discovered,
            records: report.records,
            probe: report.probe,
            attempts,
            steps,
          };
        }

        const problems = report.problems.join("\n");
        rejected.push(`attempt ${attempts}: ${problems}`);
        input.progress(`rejected: ${report.problems[0] ?? "unknown problem"}`);

        if (attempts >= input.maxAttempts) {
          throw pilotError(
            "VALIDATION_FAILED",
            `Could not compile a working script in ${attempts} attempts:\n${rejected.join("\n")}`,
          );
        }

        messages.push(toolResult(call.id, buildRetryPrompt(problems)));
        continue;
      }

      const result = await dispatchTool(input.explorer, call.name, call.args);
      input.progress(`${call.name}(${summarizeArgs(call.args)})`);
      messages.push(toolResult(call.id, result));
    }
  }

  throw pilotError(
    "VALIDATION_FAILED",
    `Explorer hit the ${input.maxSteps}-step budget without submitting a working script.` +
      (rejected.length > 0 ? `\nRejected candidates:\n${rejected.join("\n")}` : ""),
  );
}

async function dispatchTool(
  explorer: Explorer,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "goto":
      return explorer.goto(String(args.url ?? ""));
    case "find":
      return explorer.find(String(args.selector ?? ""), Number(args.limit ?? 3));
    case "fill":
      return explorer.fill(String(args.selector ?? ""), String(args.value ?? ""));
    case "click":
      return explorer.click(String(args.selector ?? ""));
    case "evaluate":
      return explorer.evaluate(String(args.code ?? ""));
    case "requests":
      return explorer.requests();
    default:
      return `Unknown tool "${name}".`;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.values(args)[0];
  if (typeof first !== "string") return "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function buildQuery(query: Partial<ScriptQuery> | undefined): ScriptQuery {
  return { keywords: "", location: "", limit: null, ...query };
}

function describeQuery(query: ScriptQuery): string {
  const parts: string[] = [];
  if (query.keywords) parts.push(`keywords="${query.keywords}"`);
  if (query.location) parts.push(`location="${query.location}"`);
  return parts.join(", ");
}

function schemaDifference(base: DataSchema, effective: DataSchema): DataSchema["fields"] {
  const baseNames = new Set(base.fields.map((field) => field.name));
  return effective.fields.filter((field) => !baseNames.has(field.name));
}
