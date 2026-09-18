import { applyD1Migrations, env } from "cloudflare:test";

// Every suite starts on the schema the deploy applies, from the same files.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
