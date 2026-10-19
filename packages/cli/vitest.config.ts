import { defineConfig } from 'vitest/config';

// `attest init` writes the global project registry; unit tests point it at a temporary home.
export default defineConfig({
  test: {
    setupFiles: ['src/_tests_/support/temporary-attest-home.ts'],
  },
});
