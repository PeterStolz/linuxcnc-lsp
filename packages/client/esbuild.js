// Bundles the VSCode extension client AND the language server into the
// client package's dist/ so the produced .vsix is fully self-contained.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Copy the bundled metadata DB next to the server bundle so the server can
// load it from __dirname at runtime inside the packaged .vsix.
function copyDb() {
  const src = path.join(__dirname, '../metadata/data/db.json');
  const destDir = path.join(__dirname, 'dist');
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(destDir, 'db.json'));
    console.log('copied metadata db.json -> dist/db.json');
  } else {
    console.warn('WARNING: metadata db.json not found; run `npm run gen:db`');
  }
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // Resolve workspace packages to their TS source so the bundle never depends on
  // each package's compiled dist/ existing — avoids a build-order race under
  // `pnpm -r run build`, where the client's esbuild can start before the libs'
  // `tsc -b` has produced dist/.
  alias: {
    '@linuxcnc/core': path.join(__dirname, '../core/src/index.ts'),
    '@linuxcnc/metadata': path.join(__dirname, '../metadata/src/index.ts'),
  },
};

const builds = [
  {
    ...common,
    entryPoints: [path.join(__dirname, 'src/extension.ts')],
    outfile: path.join(__dirname, 'dist/extension.js'),
    // The 'vscode' module is provided by the extension host at runtime.
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: [path.join(__dirname, '../server/src/index.ts')],
    outfile: path.join(__dirname, 'dist/server.js'),
    external: [],
  },
];

async function run() {
  copyDb();
  if (watch) {
    const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild: watching…');
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
