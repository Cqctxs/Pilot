/**
 * The only module in the project that talks to a model.
 *
 * Everything else — running a Pilot, searching, filtering — is deterministic.
 * Swapping providers means rewriting this file and nothing else.
 */
import OpenAI from "openai";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

export interface ModelClient {
  /** Returns raw JSON text. Callers validate; a model's word is never taken for it. */
  complete(system: string, messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<string>;
  readonly model: string;
}

export function createModelClient(env: PilotEnv): ModelClient {
  if (!env.openaiApiKey) {
    throw pilotError("AI_NOT_CONFIGURED", "OPENAI_API_KEY is not set. Compiling needs it; running a compiled Pilot does not.");
  }
  if (!env.compilerModel) {
    throw pilotError("AI_NOT_CONFIGURED", "PILOT_COMPILER_MODEL is not set. See .env.example.");
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const model = env.compilerModel;

  return {
    model,
    async complete(system, messages) {
      let response;
      try {
        response = await client.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, ...messages],
        });
      } catch (cause) {
        throw pilotError("AI_REQUEST_FAILED", `Compiler model request failed: ${(cause as Error).message}`);
      }
      const text = response.choices[0]?.message?.content;
      if (!text) {
        throw pilotError("AI_REQUEST_FAILED", "Compiler model returned an empty response");
      }
      return text;
    },
  };
}
