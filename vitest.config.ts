// Server tests run inside workerd via @cloudflare/vitest-pool-workers (v0.23 plugin API).
// Bindings are configured explicitly (not from wrangler.toml) so tests never
// depend on .dev.vars or touch the local dev database.
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          // The workerd bundled with vitest-pool-workers 0.23 supports dates up to
          // 2026-08-22; wrangler.toml uses 2026-10-01 (no behavioural flags in between we rely on).
          compatibilityDate: '2026-08-22',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['FILES'],
          bindings: {
            APP_URL: 'https://sikap.test',
            SESSION_TTL_HOURS: '12',
            PASSWORD_PEPPER: 'test-pepper-not-a-secret-0123456789abcdef',
            SETTINGS_ENC_KEY: 'test-settings-key-not-a-secret-0123456789',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    resolve: {
      alias: { '@shared': path.join(import.meta.dirname, 'shared') },
    },
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
