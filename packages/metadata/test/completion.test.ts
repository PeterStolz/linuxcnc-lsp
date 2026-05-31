import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseHal, parseIni, findSection, findEntries, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, completeHal, completeIni, MetadataIndex, buildMachineModel,
  compToComponentDef, parseCompFile, HalFileInput, IniFileInput, MachineModel,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
const FLEXI = path.resolve(__dirname, '../../../fixtures/flexicam');
let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
  const overlay = fs
    .readdirSync(FLEXI)
    .filter((f) => f.endsWith('.comp'))
    .map((f) => parseCompFile(fs.readFileSync(path.join(FLEXI, f), 'utf8')))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map(compToComponentDef);
  index.setOverlay(overlay);
});

function buildFromIni(dir: string, iniName: string): MachineModel {
  const iniPath = path.join(dir, iniName);
  const iniText = fs.readFileSync(iniPath, 'utf8');
  const ini = parseIni(iniText);
  const hal = findSection(ini, 'HAL');
  const files: HalFileInput[] = [];
  let order = 0;
  const add = (value: string, phase: 'pre' | 'postgui') => {
    const v = value.trim().split(/\s+/)[0];
    if (!v || v.startsWith('LIB:') || v.endsWith('.tcl')) return;
    const p = path.join(dir, v);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    files.push({ uri: `file://${p}`, text, lineIndex: new LineIndex(text), hal: parseHal(text), phase, order: order++ });
  };
  if (hal) {
    for (const e of findEntries(hal, 'HALFILE')) if (e.value) add(e.value.text, 'pre');
    for (const e of findEntries(hal, 'POSTGUI_HALFILE')) if (e.value) add(e.value.text, 'postgui');
  }
  const iniInput: IniFileInput = { uri: `file://${iniPath}`, lineIndex: new LineIndex(iniText), ini };
  return buildMachineModel({ iniInput, files, index });
}

/** `text` contains a single `|` marking the cursor. */
function hal(textWithCursor: string) {
  const offset = textWithCursor.indexOf('|');
  const text = textWithCursor.replace('|', '');
  return completeHal({ hal: parseHal(text), lineIndex: new LineIndex(text), text, offset, index });
}
function ini(textWithCursor: string) {
  const offset = textWithCursor.indexOf('|');
  const text = textWithCursor.replace('|', '');
  return completeIni({ ini: parseIni(text), lineIndex: new LineIndex(text), text, offset, index });
}
const labels = (items: ReturnType<typeof hal>) => items.map((i) => i.label);
const find = (items: ReturnType<typeof hal>, label: string) => items.find((i) => i.label === label);
const inserted = (items: ReturnType<typeof hal>, label: string) => {
  const it = find(items, label);
  const te = it?.textEdit;
  return te && 'newText' in te ? te.newText : it?.insertText;
};

describe('HAL completion — commands', () => {
  it('completes commands at the start of a line', () => {
    const items = hal('lo|');
    expect(labels(items)).toContain('loadrt');
    expect(labels(items)).toContain('loadusr');
    expect(labels(items)).not.toContain('net'); // filtered by "lo"
  });

  it('offers the full command set on an empty line', () => {
    const items = hal('|');
    expect(labels(items)).toContain('net');
    expect(labels(items)).toContain('setp');
    expect(labels(items)).toContain('addf');
  });

  it('command items carry the signature as detail', () => {
    const items = hal('ne|');
    expect(find(items, 'net')?.detail).toBeTruthy();
  });
});

describe('HAL completion — loadrt', () => {
  it('completes component names after loadrt', () => {
    const items = hal('loadrt and|');
    expect(labels(items)).toContain('and2');
  });

  it('offers many components on a bare loadrt', () => {
    const items = hal('loadrt |');
    expect(labels(items)).toContain('pid');
    expect(labels(items)).toContain('stepgen');
  });

  it('offers names=/count= after the component', () => {
    const items = hal('loadrt pid |');
    expect(labels(items)).toContain('names=');
    expect(labels(items)).toContain('count=');
    expect(labels(items)).not.toContain('config='); // pid is not a Mesa component
  });

  it('offers config= for a Mesa component', () => {
    expect(labels(hal('loadrt hostmot2 |'))).toContain('config=');
    expect(labels(hal('loadrt hm2_eth board_ip="10.10.10.10" |'))).toContain('config=');
  });

  it('suggests nothing on the value side of a key=', () => {
    expect(hal('loadrt pid count=|')).toEqual([]);
  });
});

describe('HAL completion — Mesa config string', () => {
  it('completes config keys right after the opening quote', () => {
    const items = hal('loadrt hostmot2\nloadrt hm2_pci config="|');
    expect(labels(items)).toContain('num_stepgens');
    expect(labels(items)).toContain('firmware');
    expect(inserted(items, 'num_stepgens')).toBe('num_stepgens=');
  });

  it('completes config keys after a space, with multiple keys already present', () => {
    const items = hal('loadrt hm2_eth config="num_encoders=3 num_st|');
    expect(labels(items)).toContain('num_stepgens');
    expect(labels(items)).not.toContain('num_encoders'); // filtered by "num_st"
  });

  it('does not fire on the value side of a config key', () => {
    expect(hal('loadrt hm2_eth config="num_stepgens=|')).toEqual([]);
  });

  it('does not fire once the config string is closed', () => {
    // after the closing quote we are back to ordinary loadrt context
    const items = hal('loadrt hm2_eth config="num_stepgens=5" |');
    expect(labels(items)).not.toContain('num_stepgens');
  });
});

describe('HAL completion — addf', () => {
  it('completes per-instance function names', () => {
    const items = hal('loadrt pid count=2\naddf pid.0.|');
    expect(labels(items)).toContain('pid.0.do-pid-calcs');
  });

  it('completes thread names as the second arg', () => {
    const items = hal('addf foo |');
    expect(labels(items)).toContain('servo-thread');
    expect(labels(items)).toContain('base-thread');
  });

  it('picks up custom thread names from loadrt threads', () => {
    const items = hal('loadrt threads name1=fast period1=50000\naddf x |');
    expect(labels(items)).toContain('fast');
  });
});

describe('HAL completion — net / signals / pins', () => {
  it('completes existing signal names as the net target', () => {
    const items = hal('net x-vel-cmd stepgen.0.velocity-cmd\nnet x-|');
    expect(labels(items)).toContain('x-vel-cmd');
  });

  it('completes instance pins as net members', () => {
    const items = hal('loadrt pid count=1\nnet sig pid.0.|');
    expect(labels(items)).toContain('pid.0.Pgain');
    expect(labels(items)).toContain('pid.0.output');
  });

  it('setp offers writable pins/params (not out pins)', () => {
    const items = hal('loadrt stepgen count=1\nsetp stepgen.0.|');
    expect(labels(items)).toContain('stepgen.0.position-cmd'); // in
    expect(labels(items)).not.toContain('stepgen.0.position-fb'); // out
  });
});

describe('HAL completion — motion absolute pins', () => {
  it('substitutes a concrete joint index', () => {
    const items = hal('net x-home joint.0.|');
    expect(labels(items)).toContain('joint.0.home-sw-in');
    expect(labels(items)).toContain('joint.0.homed');
  });

  it('offers concrete axis pins', () => {
    const items = hal('net foo axis.x.|');
    expect(labels(items)).toContain('axis.x.pos-cmd');
  });

  it('offers bare motion pins', () => {
    const items = hal('net foo motion.|');
    expect(labels(items).some((l) => l.startsWith('motion.'))).toBe(true);
  });
});

describe('HAL completion — INI references', () => {
  it('completes INI section names after [', () => {
    const items = hal('setp x.y [TR|');
    expect(labels(items)).toContain('TRAJ');
    expect(inserted(items, 'TRAJ')).toBe('TRAJ]');
  });

  it('completes INI keys after [SECTION]', () => {
    const items = hal('setp x.y [TRAJ]|');
    expect(labels(items)).toContain('LINEAR_UNITS');
  });

  it('does not hijack a leading [ when no command is typed', () => {
    expect(hal('[|')).toEqual([]);
  });
});

describe('INI file completion', () => {
  it('completes section names after [', () => {
    const items = ini('[TR|');
    expect(labels(items)).toContain('TRAJ');
    expect(inserted(items, 'TRAJ')).toBe('TRAJ]');
  });

  it('completes keys within a section', () => {
    const items = ini('[EMC]\n|');
    expect(labels(items)).toContain('MACHINE');
    expect(inserted(items, 'MACHINE')).toBe('MACHINE = ');
  });

  it('completes keys filtered by a typed prefix', () => {
    const items = ini('[TRAJ]\nLIN|');
    expect(labels(items)).toContain('LINEAR_UNITS');
  });

  it('suggests nothing on the value side of an = ', () => {
    expect(ini('[EMC]\nMACHINE = |')).toEqual([]);
  });

  it('marks already-present keys', () => {
    const items = ini('[EMC]\nMACHINE = mymachine\nVER|');
    expect(labels(items)).toContain('VERSION');
  });
});

describe('HAL completion — machine-model backed (flexicam)', () => {
  let model: MachineModel;
  beforeAll(() => {
    model = buildFromIni(FLEXI, 'Flexicam.ini');
  });

  function halM(textWithCursor: string) {
    const offset = textWithCursor.indexOf('|');
    const text = textWithCursor.replace('|', '');
    return completeHal({ hal: parseHal(text), lineIndex: new LineIndex(text), text, offset, index, model });
  }

  it('completes signals from the real cross-file signal graph', () => {
    const items = halM('net x-h|');
    expect(labels(items)).toContain('x-home-sw');
    // every suggestion respects the typed prefix
    expect(labels(items).every((l) => l.toLowerCase().startsWith('x-h'))).toBe(true);
  });

  it('completes pins on a named pid instance (pid.x)', () => {
    const items = halM('setp pid.x.|');
    expect(labels(items)).toContain('pid.x.Pgain');
  });

  it('completes INI section names present in the machine INI', () => {
    const items = halM('setp foo [HM|');
    expect(labels(items)).toContain('HMOT');
  });

  it('completes INI keys actually present in the machine INI section', () => {
    const items = halM('setp foo [HMOT]|');
    expect(labels(items)).toContain('CARD0');
  });
});
