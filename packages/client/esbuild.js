// Bundles the VSCode extension client AND the language server into the
// client package's dist/ so the produced .vsix is fully self-contained.
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
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
