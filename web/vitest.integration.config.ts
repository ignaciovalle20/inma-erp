import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// Integration suite: runs against the real inma-erp-dev Supabase project
// using web/.env.local (which points to dev). Every test file here must
// call assertDevProject() before touching anything -- see
// src/lib/__tests__/integration/devProject.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    env: loadEnv("development", __dirname, ""),
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file at a time: fixtures are isolated, but the generation
    // function processes every active service in the project, so two
    // files running it concurrently would see each other's rows.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
