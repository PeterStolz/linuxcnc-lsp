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
  },
});
