/**
 * The only module in the project that talks to a model.
 *
 * Everything else — running a Pilot, searching, filtering — is deterministic.
 * Swapping providers means rewriting this file and nothing else.
 */
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  /** Assistant message to append to the transcript verbatim. */
  raw: ChatCompletionMessageParam;
  text: string | null;
  toolCalls: ToolCall[];
}

export interface ModelClient {
  readonly model: string;
  turn(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ModelTurn>;
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

  return {
    model,
    async turn(messages, tools) {
      let response;
      try {
        response = await client.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "auto",
        });
      } catch (cause) {
        throw pilotError(
          "AI_REQUEST_FAILED",
          `Compiler model request failed: ${(cause as Error).message}`,
        );
      }

      const message = response.choices[0]?.message;
      if (!message) {
        throw pilotError("AI_REQUEST_FAILED", "Compiler model returned no message");
      }

      const toolCalls: ToolCall[] = [];
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          // A malformed argument blob is reported back as a tool result rather
          // than thrown, so the model can correct itself on the next turn.
          args = { __parseError: call.function.arguments };
        }
        toolCalls.push({ id: call.id, name: call.function.name, args });
      }

      return { raw: message as ChatCompletionMessageParam, text: message.content, toolCalls };
    },
  };
}
