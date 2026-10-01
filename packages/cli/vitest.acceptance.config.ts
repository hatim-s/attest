import { defineConfig } from 'vitest/config';

// Acceptance journeys install one packed CLI for every file; `bun run test` excludes them.
export default defineConfig({
  test: {
    globalSetup: ['src/acceptance/_tests_/packed-cli.ts'],
    include: ['src/acceptance/_tests_/**/*.test.ts'],
    maxWorkers: 1,
  },
});
