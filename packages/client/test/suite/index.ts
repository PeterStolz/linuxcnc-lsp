// Mocha bootstrap run inside the VS Code extension host. Loads every compiled
// *.test.js in this directory.
import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120000 });
  const testsRoot = __dirname;

  return new Promise((resolve, reject) => {
    try {
      for (const file of fs.readdirSync(testsRoot)) {
        if (file.endsWith('.test.js')) mocha.addFile(path.join(testsRoot, file));
      }
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} e2e test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
