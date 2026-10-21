// Frontend unit tests (pure logic) run in plain Node — NOT the workers pool used by vitest.config.ts.
// Run: npx vitest run -c vitest.web.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(import.meta.dirname, 'shared'),
      '@': path.join(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
