/**
 * Turn the vitest coverage summary into a shields.io endpoint badge.
 *
 *   pnpm test:coverage          # runs vitest --coverage (writes coverage/coverage-summary.json)
 *   tsx scripts/coverage-badge.ts   # reads that summary, writes .github/badges/coverage.json
 *
 * The README references the committed badge JSON via a shields endpoint URL, and
 * CI regenerates it on pushes to main so it never goes stale.
 */
import * as fs from 'fs';
import * as path from 'path';

const summaryPath = path.resolve('coverage/coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('coverage/coverage-summary.json not found — run `pnpm test:coverage` first.');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
  total: { lines: { pct: number } };
};
const pct = summary.total.lines.pct;
const rounded = Math.round(pct);

// Green at >=90, yellow-green >=80, yellow >=70, orange >=60, else red.
const color =
  rounded >= 90 ? 'brightgreen' :
  rounded >= 80 ? 'green' :
  rounded >= 70 ? 'yellowgreen' :
  rounded >= 60 ? 'yellow' : 'orange';

const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${rounded}%`,
  color,
};

const outDir = path.resolve('.github/badges');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(badge, null, 2) + '\n');

console.log(`coverage: ${pct}% lines -> .github/badges/coverage.json (${color})`);
