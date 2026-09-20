import { defineConfig } from "vitest/config";

/**
 * The tests that cost money.
 *
 * Everything in `tests/live/` calls a real model. They are excluded from the
 * default suite so `npm test` stays free, offline and fast enough to run on
 * every save; run these deliberately with `npm run test:live`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // One compile at a time: parallel compiles race for the same rate limit.
    fileParallelism: false,
  },
});
