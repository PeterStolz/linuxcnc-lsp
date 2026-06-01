import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  // Resolve workspace packages to their TS source so tests run without a build
  // step. pnpm symlinks each package's `main` to dist/, which does not exist on
  // a clean checkout (e.g. the CI pre-commit job), so resolving via `main` fails.
  resolve: {
    alias: {
      '@linuxcnc/core': path.resolve('packages/core/src/index.ts'),
      '@linuxcnc/metadata': path.resolve('packages/metadata/src/index.ts'),
    },
  },
  test: {
    // Only run pure unit tests here. The VSCode integration tests live in
    // packages/client and are driven by @vscode/test-electron, not vitest.
    include: ['packages/{core,metadata,server}/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // text-summary for humans in the CI log; lcov for the Codecov upload.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Still write the report when tests fail, so CI can upload coverage on a
      // red run (vitest skips it by default; the CI job trims red back on via a
      // dedicated "fail if tests failed" step).
      reportOnFailure: true,
      // Measure the runtime analysis engine: the code that actually executes when
      // the language server runs and is exercised by these unit tests. Build-time
      // code (the metadata extractors run by `gen:db`) and the LSP wiring
      // (server/src/index.ts + analysis.ts, covered by the @vscode/test-electron
      // e2e suite rather than vitest) are excluded so the number reflects what the
      // unit tests genuinely cover.
      include: [
        'packages/core/src/**',
        'packages/metadata/src/model/**',
        'packages/metadata/src/providers/**',
        'packages/metadata/src/db.ts',
        'packages/server/src/project.ts',
      ],
      exclude: ['**/*.d.ts', '**/index.ts'],
    },
  },
});
