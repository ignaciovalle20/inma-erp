import { defineConfig, devices } from "@playwright/test";

// End-to-end checks against a production build (`npm run build` first),
// served locally and talking to the inma-erp-dev Supabase project through
// web/.env.local -- the spec refuses to run against any other project.
// Run with `npm run test:e2e`. Not part of `npm test` / CI.
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
