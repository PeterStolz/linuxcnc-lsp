/**
 * Golden-corpus gate. Runs intra-file AND cross-file (machine model) analysis
 * over a real LinuxCNC configs tree and reports diagnostics grouped by rule.
 * Known-good configs should yield no Errors/Warnings (Hints/Info allowed).
 *
 *   npx tsx scripts/corpus-check.ts [configsDir]
 */
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import {
  LineIndex, parseHal, parseIni, findSection, findEntries,
  diagnoseHalIntraFile, diagnoseIniIntraFile,
} from '../packages/core/src/index';
import {
  loadDBFromFile, buildMachineModel, crossFileDiagnostics, HalFileInput,
} from '../packages/metadata/src/index';

const root = process.argv[2] ?? '/Users/peter/Documents/repos/linuxcnc/configs';
const DB = path.resolve(__dirname, '../packages/metadata/data/db.json');
const index = loadDBFromFile(DB);

const SEV: Record<number, string> = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'HINT' };
const byRule = new Map<string, number>();
const samples = new Map<string, string[]>();
let crashes = 0;

function record(file: string, code: string, sev: number | undefined, msg: string, line: number): void {
  // Only count Errors and Warnings toward the gate; Hints/Info are advisory.
  if (sev !== DiagnosticSeverity.Error && sev !== DiagnosticSeverity.Warning) return;
  const key = `${SEV[sev ?? 2]} ${code}`;
  byRule.set(key, (byRule.get(key) ?? 0) + 1);
  const list = samples.get(key) ?? [];
  if (list.length < 6) {
    list.push(`${path.relative(root, file)}:${line + 1} ${msg}`);
    samples.set(key, list);
  }
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    // attic/ holds deprecated configs that reference removed components.
    if (e.isDirectory() && e.name === 'attic') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ini')) out.push(p);
  }
}

/** Recursively resolve #INCLUDE-d INI files relative to `iniPath`. */
function resolveIncludes(iniPath: string, iniText: string, depth = 0): { uri: string; lineIndex: LineIndex; ini: ReturnType<typeof parseIni> }[] {
  if (depth > 16) return [];
  const out: ReturnType<typeof resolveIncludes> = [];
  const parsed = parseIni(iniText);
  for (const inc of parsed.includes) {
    const p = path.isAbsolute(inc.file.text) ? inc.file.text : path.join(path.dirname(iniPath), inc.file.text);
    const text = readText(p);
    if (text === undefined) continue;
    out.push({ uri: URI.file(p).toString(), lineIndex: new LineIndex(text), ini: parseIni(text) });
    out.push(...resolveIncludes(p, text, depth + 1));
  }
  return out;
}

const iniFiles: string[] = [];
walk(root, iniFiles);

let machines = 0;
const readText = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

for (const iniPath of iniFiles) {
  const iniText = readText(iniPath);
  if (iniText === undefined) continue;
  const iniUri = URI.file(iniPath).toString();
  const ini = parseIni(iniText);

  // INI intra-file diagnostics.
  try {
    const li = new LineIndex(iniText);
    for (const d of diagnoseIniIntraFile(iniText, ini, li)) record(iniPath, String(d.code), d.severity, d.message, d.range.start.line);
  } catch (e) {
    crashes++;
    console.error(`CRASH ini ${iniPath}: ${(e as Error).message}`);
  }

  const hal = findSection(ini, 'HAL');
  if (!hal) continue;
  const iniDir = path.dirname(iniPath);
  const files: HalFileInput[] = [];
  let opaque = false;
  let order = 0;
  const addHal = (value: string, phase: 'pre' | 'postgui' | 'shutdown') => {
    const v = value.trim().split(/\s+/)[0];
    if (!v || v.startsWith('LIB:') || v.endsWith('.tcl')) {
      opaque = true;
      return;
    }
    const p = path.isAbsolute(v) ? v : path.join(iniDir, v);
    const text = readText(p);
    if (text === undefined) {
      opaque = true;
      return;
    }
    files.push({ uri: URI.file(p).toString(), text, lineIndex: new LineIndex(text), hal: parseHal(text), phase, order: order++ });
  };
  for (const e of findEntries(hal, 'HALFILE')) if (e.value) addHal(e.value.text, 'pre');
  for (const e of findEntries(hal, 'POSTGUI_HALFILE')) if (e.value) addHal(e.value.text, 'postgui');
  if (files.length === 0) continue;
  machines++;

  // HAL intra-file diagnostics for each member file.
  for (const f of files) {
    try {
      for (const d of diagnoseHalIntraFile(f.text, f.hal, f.lineIndex)) {
        record(URI.parse(f.uri).fsPath, String(d.code), d.severity, d.message, d.range.start.line);
      }
    } catch (e) {
      crashes++;
      console.error(`CRASH hal ${f.uri}: ${(e as Error).message}`);
    }
  }

  // Cross-file machine diagnostics.
  try {
    const model = buildMachineModel({
      iniInput: { uri: iniUri, lineIndex: new LineIndex(iniText), ini },
      iniIncludes: resolveIncludes(iniPath, iniText),
      files, index, hasOpaqueFiles: opaque,
    });
    const cross = crossFileDiagnostics(model, index);
    for (const [uri, diags] of cross) {
      for (const d of diags) record(URI.parse(uri).fsPath, String(d.code), d.severity, d.message, d.range.start.line);
    }
  } catch (e) {
    crashes++;
    console.error(`CRASH model ${iniPath}: ${(e as Error).message}`);
  }
}

console.log(`\nScanned ${iniFiles.length} INI files; built ${machines} machine models under ${root}`);
console.log(`Crashes: ${crashes}`);
console.log(`\nError/Warning diagnostics by rule (gate must be empty for known-good configs):`);
const sorted = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
if (sorted.length === 0) console.log('  (none) ✅');
for (const [key, count] of sorted) {
  console.log(`\n  ${key}: ${count}`);
  for (const s of samples.get(key) ?? []) console.log(`      ${s}`);
}
