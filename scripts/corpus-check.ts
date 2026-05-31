/**
 * Run intra-file parsing + diagnostics over a real LinuxCNC configs tree and
 * report any diagnostics, grouped by rule. Used to validate parser robustness
 * and hunt false positives before the formal golden-corpus gate (P3).
 *
 *   npx tsx scripts/corpus-check.ts [configsDir]
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  LineIndex, parseHal, parseIni, diagnoseHalIntraFile, diagnoseIniIntraFile,
} from '../packages/core/src/index';

const root = process.argv[2] ?? '/Users/peter/Documents/repos/linuxcnc/configs';

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(hal|ini)$/i.test(ent.name)) out.push(p);
  }
}

const files: string[] = [];
walk(root, files);

let halCount = 0;
let iniCount = 0;
let crashCount = 0;
const byRule = new Map<string, number>();
const samples = new Map<string, string[]>();

for (const file of files) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const li = new LineIndex(text);
  try {
    let diags;
    if (/\.hal$/i.test(file)) {
      halCount++;
      diags = diagnoseHalIntraFile(text, parseHal(text), li);
    } else {
      iniCount++;
      diags = diagnoseIniIntraFile(text, parseIni(text), li);
    }
    for (const d of diags) {
      const code = String(d.code);
      byRule.set(code, (byRule.get(code) ?? 0) + 1);
      const list = samples.get(code) ?? [];
      if (list.length < 5) {
        const rel = path.relative(root, file);
        list.push(`${rel}:${d.range.start.line + 1} ${d.message}`);
        samples.set(code, list);
      }
    }
  } catch (e) {
    crashCount++;
    console.error(`CRASH parsing ${file}: ${(e as Error).message}`);
  }
}

console.log(`\nScanned ${files.length} files (${halCount} .hal, ${iniCount} .ini) under ${root}`);
console.log(`Parser crashes: ${crashCount}`);
console.log(`\nDiagnostics by rule:`);
const sorted = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
if (sorted.length === 0) console.log('  (none)');
for (const [code, count] of sorted) {
  console.log(`\n  ${code}: ${count}`);
  for (const s of samples.get(code) ?? []) console.log(`      ${s}`);
}
