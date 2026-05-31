import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { loadDBFromFile, MetadataIndex, crossFileDiagnostics } from '@linuxcnc/metadata';
import { Project } from '../src/project';

const DB = path.resolve(__dirname, '../../metadata/data/db.json');
let index: MetadataIndex;
let dir: string;
beforeAll(() => {
  index = loadDBFromFile(DB);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcnc-proj-'));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return URI.file(p).toString();
}

describe('Project #INCLUDE resolution (fuzz #4/#7)', () => {
  it('resolves a [SECTION]KEY defined only in an #INCLUDE-d INI (no false keyMissing)', () => {
    // The main INI defers [JOINT_0] to an included file; the HAL references it.
    write('joints.inc', '[JOINT_0]\nP = 1000\nSTEPGEN_MAXACCEL = 21.0\n');
    write('m.hal', 'loadrt pid names=pid.x\nsetp pid.x.Pgain [JOINT_0]P\nsetp pid.x.maxaccel [JOINT_0]STEPGEN_MAXACCEL\n');
    const iniUri = write('m.ini', '[EMC]\nMACHINE = test\n#INCLUDE joints.inc\n[HAL]\nHALFILE = m.hal\n');

    const project = new Project(() => undefined, () => undefined);
    project.indexIni(iniUri);
    const m = project.buildModel(iniUri, index)!;
    expect(m).toBeDefined();
    // The include was actually resolved and folded in.
    expect(m.iniIncludes.length).toBe(1);

    const diags = [...crossFileDiagnostics(m, index).values()].flat();
    const bad = diags.filter((d) => d.code === 'hal.iniref.sectionMissing' || d.code === 'hal.iniref.keyMissing');
    expect(bad.map((d) => d.message)).toEqual([]); // would be 2 false positives before the fix
  });

  it('still flags a key that is in neither the main INI nor the include', () => {
    write('joints2.inc', '[JOINT_0]\nP = 1\n');
    write('m2.hal', 'setp pid.x.Igain [JOINT_0]NOPE\n');
    const iniUri = write('m2.ini', '[EMC]\nMACHINE = t\n#INCLUDE joints2.inc\n[HAL]\nHALFILE = m2.hal\n');
    const project = new Project(() => undefined, () => undefined);
    project.indexIni(iniUri);
    const m = project.buildModel(iniUri, index)!;
    const diags = [...crossFileDiagnostics(m, index).values()].flat();
    expect(diags.some((d) => d.code === 'hal.iniref.keyMissing' && d.message.includes('NOPE'))).toBe(true);
  });

  it('does not infinite-loop on a self-referential #INCLUDE cycle', () => {
    const aUri = write('a.ini', '[EMC]\nMACHINE = t\n#INCLUDE b.ini\n[HAL]\nHALFILE = x.hal\n');
    write('b.ini', '#INCLUDE a.ini\n[FOO]\nBAR = 1\n');
    write('x.hal', 'net s pid.0.out\n');
    const project = new Project(() => undefined, () => undefined);
    project.indexIni(aUri);
    expect(() => project.buildModel(aUri, index)).not.toThrow();
  });
});
