import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // *.integration.test.ts talk to the real inma-erp-dev project, so they
    // never run as part of `npm test` (CI never talks to Supabase). Run them
    // explicitly with `npm run test:integration` (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
