import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup-env.ts"], environment: "node", testTimeout: 40000, hookTimeout: 60000 },
});
