import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./tests/helpers/env";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    env: { ...TEST_ENV },
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
