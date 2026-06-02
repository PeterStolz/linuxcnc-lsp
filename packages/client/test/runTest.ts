// Downloads a pinned VS Code, launches it with this extension loaded, and runs
// the Mocha suite in the extension host. Invoked by `pnpm run test:e2e`; CI runs
// it under xvfb (see .github/workflows/ci.yml, the `e2e` job).
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // packages/client (has package.json + the esbuilt dist/).
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    // The compiled Mocha entry (out/suite/index.js).
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    // A non-empty folder to open as the workspace root.
    const workspace = path.resolve(__dirname, '../test/fixtures/workspace');

    await runTests({
      // Pin the VS Code version for reproducible runs (a new stable release can't
      // turn the gate red with no code change); override with LCNC_VSCODE_VERSION.
      // The default is the extension's engines floor, so e2e also proves we rely
      // on no newer VS Code API.
      version: process.env.LCNC_VSCODE_VERSION || '1.100.0',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('Failed to run e2e tests:', err);
    process.exit(1);
  }
}

void main();
