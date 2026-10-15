// Setup file: runs inside workerd before each test file. Idempotent.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
