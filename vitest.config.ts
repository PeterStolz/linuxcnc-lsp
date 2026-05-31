import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run pure unit tests here. The VSCode integration tests live in
    // packages/client and are driven by @vscode/test-electron, not vitest.
    include: ['packages/{core,metadata,server}/**/*.test.ts'],
    environment: 'node',
  },
});
