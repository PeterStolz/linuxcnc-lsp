import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { loadDBFromFile, MetadataIndex, crossFileDiagnostics } from '@linuxcnc/metadata';
import { Project, resolveActiveMachine, pickMachine } from '../src/project';

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

describe('active-machine pinning for shared HAL (multi-machine)', () => {
  it('resolveActiveMachine matches by file name, path suffix, or exact path', () => {
    const uris = ['file:///cfg/a/MachineA.ini', 'file:///cfg/b/MachineB.ini'];
    expect(resolveActiveMachine('MachineA.ini', uris)).toBe('file:///cfg/a/MachineA.ini');
    expect(resolveActiveMachine('b/MachineB.ini', uris)).toBe('file:///cfg/b/MachineB.ini');
    expect(resolveActiveMachine('/cfg/a/MachineA.ini', uris)).toBe('file:///cfg/a/MachineA.ini');
    expect(resolveActiveMachine('', uris)).toBeUndefined();
    expect(resolveActiveMachine('nope.ini', uris)).toBeUndefined();
  });

  it('pickMachine prefers the active machine only when it owns the file', () => {
    expect(pickMachine([], 'x')).toBeUndefined();
    expect(pickMachine(['a', 'b'], 'b')).toBe('b');
    expect(pickMachine(['a', 'b'], 'c')).toBe('a'); // active not an owner -> first
    expect(pickMachine(['a', 'b'], undefined)).toBe('a');
  });

  it('one HAL shared by two machines: pinning selects whose context resolves the INI ref', () => {
    // shared.hal references [JOINT_0]GAIN, defined only in MachineA.
    write('shared.hal', 'loadrt pid names=pid.x\nsetp pid.x.Pgain [JOINT_0]GAIN\n');
    const aUri = write('MachineA.ini', '[EMC]\nMACHINE = A\n[JOINT_0]\nGAIN = 1\n[HAL]\nHALFILE = shared.hal\n');
    const bUri = write('MachineB.ini', '[EMC]\nMACHINE = B\n[JOINT_0]\nP = 1\n[HAL]\nHALFILE = shared.hal\n');

    const project = new Project(() => undefined, () => undefined);
    project.indexIni(aUri);
    project.indexIni(bUri);
    const halUri = URI.file(path.join(dir, 'shared.hal')).toString();
    const owners = project.machinesForHal(halUri);
    expect(owners).toContain(aUri);
    expect(owners).toContain(bUri);

    const keyMissing = (ini: string) =>
      [...crossFileDiagnostics(project.buildModel(ini, index)!, index).values()].flat()
        .some((d) => d.code === 'hal.iniref.keyMissing' && d.message.includes('GAIN'));
    expect(keyMissing(aUri)).toBe(false); // A defines GAIN
    expect(keyMissing(bUri)).toBe(true); // B does not -> would be the false error if B is picked

    // Pinning MachineA selects A even if B sorts first.
    const active = resolveActiveMachine('MachineA.ini', project.allIniUris());
    expect(pickMachine(owners, active)).toBe(aUri);
  });
});
