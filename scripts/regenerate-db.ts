/**
 * Regenerate the bundled metadata DB from the pinned LinuxCNC checkout plus the
 * ground-truth halrun dump (committed in packages/metadata/data/raw).
 *
 *   npx tsx scripts/regenerate-db.ts
 *
 * Output: packages/metadata/data/db.json
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseHalDump, parseHalDumpNames, parseCompFile, parseMan9, extractIniConfig, extractHoming,
  extractGcode, assembleDB, HAL_COMMANDS, ParsedComp, ParsedMan9,
} from '../packages/metadata/src/index';

const REPO = path.resolve(__dirname, '..');
const META = path.join(REPO, 'packages/metadata');
const RAW = path.join(META, 'data/raw');

const sourceInfo = JSON.parse(fs.readFileSync(path.join(REPO, 'metadata-source.json'), 'utf8'));
const LCNC: string = sourceInfo.localCheckout;

function readIf(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// 1. Ground-truth structure from the VM dump.
const dumpText =
  (readIf(path.join(RAW, 'hal-dump.txt')) ?? '') + '\n' + (readIf(path.join(RAW, 'hal-dump-extra.txt')) ?? '');
const dump = parseHalDump(dumpText);
const knownNames = new Set(parseHalDumpNames(dumpText));
// Also treat every component/driver source file basename as a known module
// name (hardware drivers like hal_motenc/hal_stg are not loadable in the sim
// build but are valid `loadrt` targets in real installs).
for (const dir of ['src/hal/components', 'src/hal/drivers']) {
  for (const f of listFiles(path.join(LCNC, dir), '.c')) {
    knownNames.add(path.basename(f, '.c'));
  }
  for (const f of listFiles(path.join(LCNC, dir), '.comp')) {
    knownNames.add(path.basename(f, '.comp'));
  }
}
console.log(`dump: ${dump.length} components, ${knownNames.size} known names`);

// 2. .comp docs from the source tree.
const comps: ParsedComp[] = [];
for (const dir of [path.join(LCNC, 'src/hal/components'), path.join(LCNC, 'src/hal/drivers')]) {
  for (const file of listFiles(dir, '.comp')) {
    const parsed = parseCompFile(fs.readFileSync(file, 'utf8'));
    if (parsed) comps.push(parsed);
  }
}
console.log(`.comp: ${comps.length} files`);

// 3. man9 docs.
const man9: ParsedMan9[] = [];
for (const file of listFiles(path.join(LCNC, 'docs/src/man/man9'), '.adoc')) {
  const parsed = parseMan9(fs.readFileSync(file, 'utf8'));
  if (parsed) man9.push(parsed);
}
console.log(`man9: ${man9.length} pages`);

// 4. INI schema + homing.
const iniConfigText = readIf(path.join(LCNC, 'docs/src/config/ini-config.adoc')) ?? '';
const { sections: iniSections, consumedKeys } = extractIniConfig(iniConfigText);
const homingText = readIf(path.join(LCNC, 'docs/src/config/ini-homing.adoc')) ?? '';
const homingKeys = extractHoming(homingText);
console.log(`ini: ${Object.keys(iniSections).length} sections, ${consumedKeys.length} keys; homing: ${Object.keys(homingKeys).length}`);

// 5. G-code / M-code / other-word docs.
const gcodeWords = extractGcode(
  readIf(path.join(LCNC, 'docs/src/gcode/g-code.adoc')) ?? '',
  readIf(path.join(LCNC, 'docs/src/gcode/m-code.adoc')) ?? '',
  readIf(path.join(LCNC, 'docs/src/gcode/other-code.adoc')) ?? '',
);
console.log(`gcode: ${Object.keys(gcodeWords).length} words`);

const db = assembleDB({
  source: {
    repo: sourceInfo.repo,
    commit: sourceInfo.commit,
    describe: sourceInfo.describe,
    lcncVersion: sourceInfo.lcncVersion,
    generatedAt: process.env.SOURCE_DATE ?? '',
  },
  dump,
  comps,
  man9,
  iniSections,
  consumedKeys,
  homingKeys,
  knownNames: [...knownNames],
  commands: HAL_COMMANDS,
  gcodeWords,
});

const outPath = path.join(META, 'data/db.json');
fs.writeFileSync(outPath, JSON.stringify(db, null, 1));
const stats = {
  components: Object.keys(db.components).length,
  withPins: Object.values(db.components).filter((c) => c.pins.length).length,
  iniSections: Object.keys(db.iniSections).length,
  homingKeys: Object.keys(db.homingKeys).length,
  bytes: fs.statSync(outPath).size,
};
console.log('DB written:', outPath, stats);
