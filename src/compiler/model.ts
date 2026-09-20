/**
 * The only module in the project that talks to a model.
 *
 * Everything else — running a Pilot, searching, filtering — is deterministic.
 * Swapping providers means rewriting this file and nothing else.
 *
 * This speaks the Responses API rather than Chat Completions. That is not a
 * preference: gpt-5.6-sol rejects function tools on `/v1/chat/completions`
 * unless reasoning is switched off entirely ("Function tools with
 * reasoning_effort are not supported ... use /v1/responses or set
 * reasoning_effort to 'none'"), and the compiler is nothing *but* function
 * tools. Exploration is where the thinking happens — choosing a selector,
 * working out why an extraction came back empty — so trading reasoning away to
 * keep the older endpoint would be the wrong half to keep.
 *
 * The transcript is therefore a list of Responses input items. Assistant output
 * is appended verbatim, reasoning items included, because handing those back is
 * what lets the model continue a thought across turns instead of restarting it.
 */
import OpenAI from "openai";
import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One entry in the conversation. Append-only; never rewritten. */
export type TranscriptItem = ResponseInputItem;

export interface ModelTurn {
  /** Assistant output, to append to the transcript verbatim. */
  raw: TranscriptItem[];
  text: string | null;
  toolCalls: ToolCall[];
}

/** The nested Chat Completions tool shape `tools.ts` is written in. */
export interface ChatStyleTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelClient {
  readonly model: string;
  turn(transcript: ResponseInput, tools: readonly ChatStyleTool[]): Promise<ModelTurn>;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/**
 * Only sent when configured. Models disagree about which levels they accept,
 * and an unsupported value is a hard request failure rather than something the
 * compiler could recover from, so silence is the safe default.
 */
function effortOf(env: PilotEnv): Effort | null {
  if (!env.compilerEffort) return null;
  const value = env.compilerEffort.toLowerCase();
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw pilotError(
      "AI_NOT_CONFIGURED",
      `PILOT_COMPILER_EFFORT must be one of ${EFFORTS.join(", ")}; got "${env.compilerEffort}".`,
    );
  }
  return value as Effort;
}

/** Tool definitions live in `tools.ts` in the nested form; the wire wants flat. */
function toResponsesTools(tools: readonly ChatStyleTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
}

export function createModelClient(env: PilotEnv): ModelClient {
  if (!env.openaiApiKey) {
    throw pilotError(
      "AI_NOT_CONFIGURED",
      "OPENAI_API_KEY is not set. Compiling needs it; running a compiled Pilot does not.",
    );
  }
  if (!env.compilerModel) {
    throw pilotError("AI_NOT_CONFIGURED", "PILOT_COMPILER_MODEL is not set. See .env.example.");
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const model = env.compilerModel;
  const effort = effortOf(env);

  return {
    model,
    async turn(transcript, tools) {
      let response;
      try {
        response = await client.responses.create({
          model,
          input: transcript,
          tools: toResponsesTools(tools),
          tool_choice: "auto",
          ...(effort ? { reasoning: { effort } } : {}),
        });
      } catch (cause) {
        throw pilotError(
          "AI_REQUEST_FAILED",
          `Compiler model request failed: ${(cause as Error).message}`,
        );
      }

      const output = response.output ?? [];
      if (output.length === 0) {
        throw pilotError("AI_REQUEST_FAILED", "Compiler model returned no output");
      }

      const toolCalls: ToolCall[] = [];
      for (const item of output) {
        if (item.type !== "function_call") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
        } catch {
          // A malformed argument blob is reported back as a tool result rather
          // than thrown, so the model can correct itself on the next turn.
          args = { __parseError: item.arguments };
        }
        toolCalls.push({ id: item.call_id, name: item.name, args });
      }

      const text = response.output_text?.trim() || null;
      return { raw: output as TranscriptItem[], text, toolCalls };
    },
  };
}

/** The transcript entry for one tool's result. */
export function toolResult(callId: string, output: string): TranscriptItem {
  return { type: "function_call_output", call_id: callId, output };
}
