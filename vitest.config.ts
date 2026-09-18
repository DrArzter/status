import path from "node:path";
import { cloudflarePool, cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against a real D1, because the parts worth testing
// are SQL: the rollups, the retention and the state a window of checks implies.
// The migrations handed to the tests are the files the deploy applies.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

const options = {
  wrangler: { configPath: "./wrangler.jsonc" },
  miniflare: {
    compatibilityDate: "2026-08-22",
    d1Databases: { DB: "status-test" },
    bindings: { TEST_MIGRATIONS: migrations },
  },
};

export default defineConfig({
  // The plugin supplies `cloudflare:test`; the pool runs the suites in workerd.
  plugins: [cloudflareTest(options)],
  test: {
    setupFiles: ["./test/setup.ts"],
    pool: cloudflarePool(options),
  },
});
