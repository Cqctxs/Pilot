import { defineConfig } from "vitest/config";

/**
 * Deliberately opt-in: this suite calls a real model and six public websites.
 * It is a product acceptance test, not something to put on every save or CI
 * push. The file itself keeps the sources sequential and rate-friendly.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/matrix/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
