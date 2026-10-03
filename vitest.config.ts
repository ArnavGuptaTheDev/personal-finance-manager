import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        {
          // The real Worker (server/worker.ts) with a local D1, run inside workerd.
          plugins: [
            cloudflareTest({
              main: './server/worker.ts',
              wrangler: { configPath: './wrangler.toml' },
              miniflare: {
                bindings: {
                  APP_URL: 'https://app.test',
                  OWNER_EMAILS: 'owner@test.com,second-owner@test.com',
                  GOOGLE_CLIENT_ID: 'test-client-id',
                  GOOGLE_CLIENT_SECRET: 'test-client-secret',
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: {
            name: 'api',
            include: ['test/api/**/*.test.ts'],
            setupFiles: ['./test/api/setup.ts'],
          },
        },
        {
          // Browser-side modules (parsers, categoriser) under Node.
          test: {
            name: 'unit',
            include: ['test/unit/**/*.test.ts', 'test/parsers/**/*.test.ts'],
            environment: 'node',
          },
        },
      ],
    },
  };
});
