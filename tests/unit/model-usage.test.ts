import { describe, expect, it } from "vitest";
import { addModelUsage, emptyModelUsage } from "../../src/compiler/model.js";

describe("compiler model usage", () => {
  it("adds selection and compilation without double-counting cached tokens", () => {
    const selection = {
      requests: 1,
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    };
    const compilation = {
      requests: 2,
      inputTokens: 300,
      cachedInputTokens: 200,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 340,
    };

    expect(addModelUsage(selection, compilation)).toEqual({
      requests: 3,
      inputTokens: 400,
      cachedInputTokens: 260,
      outputTokens: 60,
      reasoningTokens: 15,
      totalTokens: 460,
    });
  });

  it("starts at zero for fake or model-free operations", () => {
    expect(emptyModelUsage().totalTokens).toBe(0);
  });
});
