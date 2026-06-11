import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    coverage: {
      include: ['src/**/*'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{js,ts}'],
          exclude: ['src/hooks/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['**/*.test.tsx', 'src/hooks/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            screenshotDirectory: 'vitest-test-results',
            instances: [
              { browser: 'chromium' },
            ],
          },
        },
      },
    ],
    reporters: [
      'default',
      // conditional reporter
      process.env.CI ? 'github-actions' : {},
    ],
    env: {
      ...loadEnv('', process.cwd(), ''), // Expose .env variables to Node.js
      // Tests must not depend on real secrets. There are no .env files in the
      // repo; skipping Env validation lets modules that import Env.ts load with
      // the required keys absent. Tests that need a database use an in-memory one.
      SKIP_ENV_VALIDATION: 'true',
    },
  },
  define: {
    'process.env': JSON.stringify({
      ...loadEnv('', process.cwd(), 'NEXT_PUBLIC_'), // Expose .env variables to browser
      SKIP_ENV_VALIDATION: 'true', // Browser tests must not depend on real secrets either.
    }),
  },
});
