import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // tests/live calls a real model and costs money: npm run test:live.
    exclude: ["tests/live/**"],
  },
});
