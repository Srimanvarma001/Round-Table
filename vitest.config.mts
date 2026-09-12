import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Test configuration, section 19.
 *
 * Two layers: `src/test/unit` (pure functions) and `src/test/integration`
 * (the orchestrator against `MockLLMAdapter` on a temporary SQLite file).
 * No browser automation in v1.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws by design when imported outside a React Server
      // Component. `src/lib/config.ts` and friends legitimately carry that
      // import, and the unit tests must be able to import those modules
      // directly, so the guard is stubbed here and the real one keeps
      // protecting the app build.
      'server-only': fileURLToPath(new URL('./src/test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/test/**/*.test.ts'],
    // Integration suites each build their own SQLite file and drive the
    // orchestrator. Running the files one at a time keeps the better-sqlite3
    // handles and the in-process event bus coherent, and keeps the pino output
    // readable when a suite fails.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/lib/**/*.d.ts',
        'src/lib/db/schema.ts',
        'src/lib/llm/mock.ts',
      ],
      // Section 19.3: threshold 80 percent on `src/lib`. The provider adapters
      // that talk to real networks are covered by recorded fixtures rather
      // than by live calls, so the branch floor is what actually bites.
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
