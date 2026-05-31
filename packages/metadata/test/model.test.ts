import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { parseHal, parseIni, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, MetadataIndex, buildMachineModel, crossFileDiagnostics,
  definition, references, documentHighlights, HalFileInput, IniFileInput,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
});

function halFile(uri: string, text: string, order: number): HalFileInput {
  return { uri, text, lineIndex: new LineIndex(text), hal: parseHal(text), phase: 'pre', order };
}
function iniFile(uri: string, text: string): IniFileInput {
  return { uri, lineIndex: new LineIndex(text), ini: parseIni(text) };
}

// A small two-file machine resembling flexicam's structure.
const INI = `[KINS]
JOINTS = 1
[EMCMOT]
SERVO_PERIOD = 1000000
[JOINT_0]
P = 1000
STEP_SCALE = 663.1
`;
const MAIN = `loadrt [KINS]KINEMATICS
loadrt pid names=pid.x
loadrt scale names=spindle-fb-scale
setp pid.x.Pgain [JOINT_0]P
setp pid.x.Dgain [JOINT_0]MISSING_KEY
net x-pos-cmd <= joint.0.motor-pos-cmd
net x-pos-cmd => pid.x.command
`;
const CUSTOM = `net x-pos-cmd => spindle-fb-scale.in
setp spindle-fb-scale.gain [SPINDLE_0]MAX_SPEED
`;

function model() {
  return buildMachineModel({
    iniInput: iniFile('file:///m.ini', INI),
    files: [halFile('file:///main.hal', MAIN, 0), halFile('file:///custom.hal', CUSTOM, 1)],
    index,
  });
}

describe('MachineModel', () => {
  it('registers named instances mapped to components', () => {
    const m = model();
    expect(m.instances.get('pid.x')?.comp).toBe('pid');
    expect(m.instances.get('spindle-fb-scale')?.comp).toBe('scale');
  });

  it('builds a cross-file signal graph (writers/readers)', () => {
    const m = model();
    const sig = m.signals.get('x-pos-cmd')!;
    expect(sig).toBeDefined();
    // joint.0.motor-pos-cmd (out) is the writer; pid.x.command + scale.in are readers
    expect(sig.writers.length).toBe(1);
    expect(sig.writers[0].fullName).toBe('joint.0.motor-pos-cmd');
    expect(sig.readers.map((r) => r.fullName)).toContain('pid.x.command');
    expect(sig.readers.map((r) => r.fullName)).toContain('spindle-fb-scale.in');
  });
});

describe('cross-file diagnostics', () => {
  it('flags an INI key that is missing from the INI', () => {
    const diags = crossFileDiagnostics(model(), index);
    const main = diags.get('file:///main.hal') ?? [];
    expect(main.some((d) => d.code === 'hal.iniref.keyMissing' && d.message.includes('MISSING_KEY'))).toBe(true);
  });

  it('flags a missing INI section', () => {
    const diags = crossFileDiagnostics(model(), index);
    const custom = diags.get('file:///custom.hal') ?? [];
    expect(custom.some((d) => d.code === 'hal.iniref.sectionMissing' && d.message.includes('SPINDLE_0'))).toBe(true);
  });

  it('does NOT flag INI keys that are present', () => {
    const diags = crossFileDiagnostics(model(), index);
    const main = diags.get('file:///main.hal') ?? [];
    expect(main.some((d) => d.message.includes('[JOINT_0]P'))).toBe(false);
  });

  it('flags multiple writers on a signal', () => {
    const text = 'loadrt and2 count=2\nnet s and2.0.out and2.1.out\n';
    const m = buildMachineModel({ files: [halFile('file:///w.hal', text, 0)], index });
    const diags = crossFileDiagnostics(m, index);
    const d = diags.get('file:///w.hal') ?? [];
    expect(d.some((x) => x.code === 'hal.signal.multipleWriters')).toBe(true);
  });
});

describe('INI value validation', () => {
  function iniDiags(text: string) {
    const m = buildMachineModel({ iniInput: iniFile('file:///v.ini', text), files: [], index });
    return crossFileDiagnostics(m, index).get('file:///v.ini') ?? [];
  }

  it('flags a non-numeric value for a real-typed key', () => {
    const d = iniDiags('[JOINT_0]\nMAX_VELOCITY = fast\n');
    expect(d.some((x) => x.code === 'ini.value.typeMismatch' && x.message.includes('real number'))).toBe(true);
  });

  it('accepts a valid real value', () => {
    const d = iniDiags('[JOINT_0]\nMAX_VELOCITY = 12.5\n');
    expect(d.some((x) => x.code.startsWith('ini.value'))).toBe(false);
  });

  it('accepts scientific / signed reals', () => {
    const d = iniDiags('[JOINT_0]\nMAX_VELOCITY = -1.5e-3\n');
    expect(d.some((x) => x.code.startsWith('ini.value'))).toBe(false);
  });

  it('flags an enum value outside the documented set', () => {
    const d = iniDiags('[JOINT_0]\nTYPE = ROTARY\n');
    expect(d.some((x) => x.code === 'ini.value.enumMismatch' && x.message.includes('LINEAR'))).toBe(true);
  });

  it('accepts a documented enum value, case-insensitively', () => {
    const d = iniDiags('[JOINT_0]\nTYPE = linear\n');
    expect(d.some((x) => x.code === 'ini.value.enumMismatch')).toBe(false);
  });

  it('accepts hex literals for integer-typed keys', () => {
    const d = iniDiags('[EMC]\nDEBUG = 0x7FFFFFFF\n');
    expect(d.some((x) => x.code.startsWith('ini.value'))).toBe(false);
  });

  it('does not judge values containing INI substitution', () => {
    const d = iniDiags('[JOINT_0]\nMAX_VELOCITY = [TRAJ]MAX_LINEAR_VELOCITY\n');
    expect(d.some((x) => x.code.startsWith('ini.value'))).toBe(false);
  });
});

describe('navigation', () => {
  it('go-to-definition on a signal jumps to its first net', () => {
    const m = model();
    // offset of 'x-pos-cmd' usage in custom.hal
    const off = CUSTOM.indexOf('x-pos-cmd') + 2;
    const defs = definition(m, 'file:///custom.hal', off);
    expect(defs.length).toBe(1);
    expect(defs[0].uri).toBe('file:///main.hal'); // defined first in main.hal
  });

  it('find-references on a signal spans both files', () => {
    const m = model();
    const off = MAIN.indexOf('net x-pos-cmd') + 5;
    const refs = references(m, 'file:///main.hal', off);
    const uris = new Set(refs.map((r) => r.uri));
    expect(uris.has('file:///main.hal')).toBe(true);
    expect(uris.has('file:///custom.hal')).toBe(true);
  });

  it('go-to-definition on an INI ref jumps to the INI key', () => {
    const m = model();
    const off = MAIN.indexOf('[JOINT_0]P') + 2;
    const defs = definition(m, 'file:///main.hal', off);
    expect(defs[0]?.uri).toBe('file:///m.ini');
  });

  it('find-references from the INI key finds the HAL usage + the declaration', () => {
    const m = model();
    const off = INI.indexOf('P = 1000'); // the 'P' key in [JOINT_0]
    const refs = references(m, 'file:///m.ini', off);
    const uris = refs.map((r) => r.uri);
    expect(uris).toContain('file:///main.hal'); // [JOINT_0]P used in HAL
    expect(uris).toContain('file:///m.ini'); // the declaration
  });

  it('find-references from the INI excludes the declaration when asked', () => {
    const m = model();
    const off = INI.indexOf('P = 1000');
    const refs = references(m, 'file:///m.ini', off, false);
    expect(refs.every((r) => r.uri === 'file:///main.hal')).toBe(true);
    expect(refs.length).toBe(1);
  });

  it('find-references from an unreferenced INI key returns just the declaration', () => {
    const m = model();
    const off = INI.indexOf('STEP_SCALE');
    const refs = references(m, 'file:///m.ini', off);
    expect(refs.length).toBe(1);
    expect(refs[0].uri).toBe('file:///m.ini');
  });

  it('document highlights an INI key within the INI file', () => {
    const m = model();
    const off = INI.indexOf('P = 1000');
    const hls = documentHighlights(m, 'file:///m.ini', off);
    expect(hls.length).toBeGreaterThanOrEqual(1);
  });
});
