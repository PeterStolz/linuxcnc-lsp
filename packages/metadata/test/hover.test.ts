import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { parseHal, parseIni, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, hoverHal, hoverIni, MetadataIndex, buildMachineModel, iniRefsTo,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
});

function hHal(text: string, marker: string) {
  const offset = text.indexOf(marker) + Math.floor(marker.length / 2);
  return hoverHal(parseHal(text), new LineIndex(text), offset, index);
}
function hIni(text: string, marker: string) {
  const offset = text.indexOf(marker) + Math.floor(marker.length / 2);
  return hoverIni(parseIni(text), new LineIndex(text), offset, index);
}
const value = (h: ReturnType<typeof hoverHal>) =>
  h && typeof h.contents === 'object' && 'value' in h.contents ? (h.contents as any).value : '';

describe('HAL hover', () => {
  it('hovers a halcmd command', () => {
    const h = hHal('loadrt and2 count=2', 'loadrt');
    expect(value(h)).toContain('loadrt');
    expect(value(h)).toContain('realtime');
  });

  it('hovers a component name', () => {
    const h = hHal('loadrt scale', 'scale');
    expect(value(h)).toContain('scale');
    expect(value(h).toLowerCase()).toContain('scale and offset');
  });

  it('hovers a pin on a default-named instance', () => {
    const h = hHal('setp scale.0.gain 2.0', 'scale.0.gain');
    expect(value(h)).toContain('float');
    expect(value(h)).toContain('scale');
  });

  it('hovers a pin on a NAMED instance (pid.x.Pgain)', () => {
    const h = hHal('setp pid.x.Pgain 100', 'pid.x.Pgain');
    expect(value(h)).toContain('pid');
    expect(value(h)).toContain('Proportional gain');
  });

  it('hovers an absolute motion/joint pin', () => {
    const h = hHal('net x-home joint.0.home-sw-in', 'joint.0.home-sw-in');
    expect(value(h)).toContain('motion');
    expect(value(h)).toContain('bit');
  });

  it('hovers an INI reference showing the key doc', () => {
    const h = hHal('setp stepgen.0.maxaccel [JOINT_0]STEPGEN_MAXACCEL', '[JOINT_0]STEPGEN_MAXACCEL');
    expect(value(h)).toContain('JOINT_0');
    expect(value(h)).toContain('STEPGEN_MAXACCEL');
  });

  it('renders homing docs when hovering a HOME_ INI ref in a JOINT section', () => {
    const h = hHal('setp foo.bar [JOINT_0]HOME_SEARCH_VEL', '[JOINT_0]HOME_SEARCH_VEL');
    expect(value(h)).toContain('machine-units per second');
  });
});

describe('INI hover', () => {
  it('hovers a section name', () => {
    const h = hIni('[TRAJ]\nMAX_LINEAR_VELOCITY = 5', '[TRAJ]');
    expect(value(h)).toContain('TRAJ');
  });

  it('hovers an INI key with its documented description', () => {
    const h = hIni('[TRAJ]\nMAX_LINEAR_VELOCITY = 5', 'MAX_LINEAR_VELOCITY');
    expect(value(h)).toContain('maximum velocity');
  });

  it('renders homing docs when hovering a homing key in a JOINT section', () => {
    const h = hIni('[JOINT_0]\nHOME_SEARCH_VEL = 20', 'HOME_SEARCH_VEL');
    expect(value(h)).toContain('machine-units per second');
  });
});

describe('INI hover — cross-reference annotation', () => {
  function modelFor(iniText: string, halText: string) {
    const ini = parseIni(iniText);
    return buildMachineModel({
      iniInput: { uri: 'file:///m.ini', lineIndex: new LineIndex(iniText), ini },
      files: [{ uri: 'file:///m.hal', text: halText, lineIndex: new LineIndex(halText), hal: parseHal(halText), phase: 'pre', order: 0 }],
      index,
    });
  }
  function hIniM(iniText: string, marker: string, halText: string) {
    const offset = iniText.indexOf(marker) + Math.floor(marker.length / 2);
    const model = modelFor(iniText, halText);
    return hoverIni(
      parseIni(iniText), new LineIndex(iniText), offset, index,
      (s, k) => iniRefsTo(model, s, k).length,
    );
  }

  it('reports the number of HAL references for a key used from HAL', () => {
    const h = hIniM(
      '[JOINT_0]\nSTEPGEN_MAXACCEL = 21\n',
      'STEPGEN_MAXACCEL',
      'loadrt stepgen step_type=0\nsetp stepgen.0.maxaccel [JOINT_0]STEPGEN_MAXACCEL\n',
    );
    expect(value(h)).toMatch(/Referenced by \*\*1\*\* HAL location/);
  });

  it('does not flag a core-consumed key that HAL never references', () => {
    const h = hIniM('[TRAJ]\nMAX_LINEAR_VELOCITY = 5\n', 'MAX_LINEAR_VELOCITY', 'loadrt stepgen\n');
    expect(value(h)).toContain('Read directly by LinuxCNC core');
    expect(value(h)).not.toContain('Not referenced');
  });

  it('warns when a custom key is referenced by no HAL file', () => {
    const h = hIniM('[CUSTOM]\nMY_ORPHAN_KEY = 1\n', 'MY_ORPHAN_KEY', 'loadrt stepgen\n');
    expect(value(h)).toContain('Not referenced by any HAL file');
  });
});
