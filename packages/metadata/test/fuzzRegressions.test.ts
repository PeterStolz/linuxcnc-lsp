import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { parseHal, parseIni, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, MetadataIndex, buildMachineModel, crossFileDiagnostics,
  hoverGcode, completeGcode, completeHal, completeIni, locateHal, references, hoverHal, rename,
  adocToMarkdown, HalFileInput, MachineModel,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
let index: MetadataIndex;
beforeAll(() => { index = loadDBFromFile(DB); });

function model(iniText: string | undefined, hals: Array<{ uri: string; text: string }>): MachineModel {
  const files: HalFileInput[] = hals.map((h, i) => ({
    uri: h.uri, text: h.text, lineIndex: new LineIndex(h.text), hal: parseHal(h.text), phase: 'pre', order: i,
  }));
  return buildMachineModel({
    iniInput: iniText !== undefined ? { uri: 'file:///m.ini', lineIndex: new LineIndex(iniText), ini: parseIni(iniText) } : undefined,
    files, index,
  });
}
const codes = (m: MachineModel, uri: string) => (crossFileDiagnostics(m, index).get(uri) ?? []).map((d) => d.code);
const ghover = (text: string, marker: string) => {
  const off = text.indexOf(marker) + Math.floor(marker.length / 2);
  const h = hoverGcode(text, new LineIndex(text), off, index);
  return h && typeof h.contents === 'object' && 'value' in h.contents ? (h.contents as { value: string }).value : '';
};

describe('AXIS_X/Y/Z schema resolution (fuzz #5/#6)', () => {
  it('resolves the common axis letters to the AXIS schema', () => {
    expect(index.iniSection('AXIS_X')).toBeDefined();
    expect(index.iniSection('AXIS_Y')).toBeDefined();
    expect(index.iniSection('AXIS_Z')).toBeDefined();
    expect(index.iniSection('AXIS_A')).toBeDefined();
  });
  it('does not resolve non-axis letters', () => {
    expect(index.iniSection('AXIS_D')).toBeUndefined();
    expect(index.iniSection('AXIS_Q')).toBeUndefined();
  });
  it('validates AXIS_X values now that the schema resolves', () => {
    const m = model('[AXIS_X]\nMAX_VELOCITY = fast\n', []);
    expect(codes(m, 'file:///m.ini')).toContain('ini.value.typeMismatch');
  });
});

describe('setp on read-only target (fuzz #10/#16)', () => {
  it('flags setp of an output pin', () => {
    const m = model(undefined, [{ uri: 'a.hal', text: 'loadrt pid names=pid.x\nsetp pid.x.output 5\n' }]);
    expect(codes(m, 'a.hal')).toContain('hal.param.readonlyParamSet');
  });
  it('flags setp of a read-only (R) parameter', () => {
    const m = model(undefined, [{ uri: 'a.hal', text: 'loadrt pid names=pid.x\nsetp pid.x.do-pid-calcs.tmax-increased 5\n' }]);
    expect(codes(m, 'a.hal')).toContain('hal.param.readonlyParamSet');
  });
  it('does NOT flag setp of a writable input pin', () => {
    const m = model(undefined, [{ uri: 'a.hal', text: 'loadrt pid names=pid.x\nsetp pid.x.Pgain 5\n' }]);
    expect(codes(m, 'a.hal')).not.toContain('hal.param.readonlyParamSet');
  });
});

describe('INI integer prefixes (fuzz #26)', () => {
  const ok = (v: string) => !codes(model(`[EMC]\nDEBUG = ${v}\n`, []), 'file:///m.ini').includes('ini.value.typeMismatch');
  it('accepts uppercase 0X hex', () => expect(ok('0X10')).toBe(true));
  it('accepts octal 0o and binary 0b', () => { expect(ok('0o17')).toBe(true); expect(ok('0b1010')).toBe(true); });
  it('still rejects a non-number', () => expect(ok('banana')).toBe(false));
});

describe('navigation merge + missing cases (fuzz #9/#23)', () => {
  it('locateHal returns the whole merged pin for an embedded INI substitution', () => {
    const text = 'net s hm2_[HOSTMOT2](BOARD).0.gpio.001.in\n';
    const off = text.indexOf('.0.gpio') + 3;
    const loc = locateHal(parseHal(text), off);
    expect(loc?.kind).toBe('pin');
    if (loc?.kind === 'pin') expect(loc.name.startsWith('hm2_')).toBe(true);
  });
  it('does not conflate distinct pins sharing a trailing fragment', () => {
    const m = model(undefined, [
      { uri: 'a.hal', text: 'net s hm2_[HOSTMOT2](BOARD).0.gpio.001.in\n' },
      { uri: 'b.hal', text: 'net t other.0.gpio.001.in\n' },
    ]);
    const a = 'net s hm2_[HOSTMOT2](BOARD).0.gpio.001.in\n';
    const refs = references(m, 'a.hal', a.indexOf('.0.gpio') + 3);
    expect(refs.every((r) => r.uri !== 'b.hal')).toBe(true);
  });
  it('locates a pin on linkpp / unlinkp / alias statements', () => {
    const at = (t: string, needle: string) => t.indexOf(needle) + 2;
    const lp = 'linkpp a.0.out b.0.in';
    expect(locateHal(parseHal(lp), at(lp, 'a.0.out'))?.kind).toBe('pin');
    expect(locateHal(parseHal(lp), at(lp, 'b.0.in'))?.kind).toBe('pin');
    const up = 'unlinkp a.0.in';
    expect(locateHal(parseHal(up), at(up, 'a.0.in'))?.kind).toBe('pin');
    const al = 'alias pin a.0.in myalias';
    expect(locateHal(parseHal(al), at(al, 'a.0.in'))?.kind).toBe('pin');
  });
});

describe('G-code provider fixes (fuzz #13/#29/#21)', () => {
  it('numbered params 5400/5420 are not mislabeled as coordinate-system offsets', () => {
    expect(ghover('G0 X#5400', '#5400')).toContain('tool');
    expect(ghover('G0 X#5420', '#5420')).toContain('position');
    expect(ghover('G0 X#5420', '#5420')).not.toContain('coordinate system offset');
  });
  it('explains an indirect ## reference', () => {
    expect(ghover('X##5220', '##5220')).toContain('indirect');
  });
  it('completeGcode does not fire inside a comment or expression identifier', () => {
    const inComment = 'G0 (rapid to M';
    expect(completeGcode(inComment, new LineIndex(inComment), inComment.length, index)).toEqual([]);
    const inExpr = 'G1 X[SIN';
    expect(completeGcode(inExpr, new LineIndex(inExpr), inExpr.length, index)).toEqual([]);
  });
  it('still completes G/M codes in a normal position', () => {
    const t = 'G';
    expect(completeGcode(t, new LineIndex(t), 1, index).map((i) => i.label)).toContain('G1');
  });
});

describe('completion bounds + blank section (fuzz #3/#20)', () => {
  it('completeHal stays bounded and fast on a clamped huge count', () => {
    const text = 'loadrt pid count=99999999\nnet sig pid.0.P';
    const t0 = performance.now();
    const items = completeHal({ hal: parseHal(text), lineIndex: new LineIndex(text), text, offset: text.length, index });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(items.length).toBeLessThan(20000);
  });
  it('completeIni does not offer an empty section name', () => {
    const text = '[EMC]\n[]\n[';
    const labels = completeIni({ ini: parseIni(text), lineIndex: new LineIndex(text), text, offset: text.length, index }).map((i) => i.label);
    expect(labels).not.toContain('');
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });
});

describe('G-code multi-code / dash-range docs (fuzz #11/#12/#28)', () => {
  it('gives each code in a shared section ITS own description', () => {
    expect(ghover('G93', 'G93')).toContain('Inverse Time');
    expect(ghover('G94', 'G94')).toContain('Units per Minute');
    expect(ghover('G95', 'G95')).toContain('Units per Revolution');
  });
  it('expands dash-joined ranges so every code has docs', () => {
    expect(ghover('M62 P0', 'M62')).toContain('digital output');
    expect(ghover('M65 P0', 'M65')).toContain('digital output');
    expect(ghover('G55', 'G55')).toContain('coordinate system');
    expect(ghover('G59.3', 'G59.3')).toContain('coordinate system');
  });
  it('does not leave a leading dash in dash-range titles', () => {
    const v = ghover('M100', 'M100');
    expect(v).not.toMatch(/^###\s*`M100`\s*—\s*-/);
  });
});

describe('audit accuracy fixes (#2/#4/#7)', () => {
  const hh = (text: string, marker: string) => {
    const off = text.indexOf(marker) + 2;
    const h = hoverHal(parseHal(text), new LineIndex(text), off, index);
    return h && typeof h.contents === 'object' && 'value' in h.contents ? (h.contents as { value: string }).value : '';
  };

  it('hal_parport pins resolve as parport.0.* (prefix strip + hyphenation)', () => {
    expect(index.componentByPrefix('parport')?.name).toBe('hal_parport');
    const m = model(undefined, [{ uri: 'a.hal', text: 'loadrt hal_parport cfg=0x378\nnet x parport.0.pin-01-out\n' }]);
    expect([...m.instances.keys()]).toContain('parport.0');
    expect(hh('net x parport.0.pin-01-out', 'pin-01-out')).toContain('hal_parport');
  });

  it('underscore component instances hyphenate (estop_latch -> estop-latch.0.*)', () => {
    expect(hh('loadrt estop_latch\nnet e estop-latch.0.ok-in', 'ok-in')).toContain('estop_latch');
  });

  it('flags multipleWriters across num_chan= channels (was a false-negative)', () => {
    const m = model(undefined, [{ uri: 'a.hal', text: 'loadrt pid num_chan=3\nnet foo pid.0.output pid.1.output\n' }]);
    expect(codes(m, 'a.hal')).toContain('hal.signal.multipleWriters');
  });

  it('does not emit noReader/noWriter for an arrow-only unresolved pin', () => {
    // unknowncomp is not in the DB -> direction unresolved; the `<=` arrow alone
    // must NOT make it "confident" (that produced false dangling Hints).
    const m = model(undefined, [{ uri: 'a.hal', text: 'net sig <= unknowncomp.0.out\n' }]);
    const c = codes(m, 'a.hal');
    expect(c).not.toContain('hal.signal.noReader');
    expect(c).not.toContain('hal.signal.noWriter');
  });
});

describe('G-code spaced-dash ranges (audit #5/#6)', () => {
  it('includes interior plane codes G18/G19/G17.1/G18.1', () => {
    for (const c of ['G18', 'G19', 'G17.1', 'G18.1']) expect(ghover(c, c)).toContain('Plane Select');
  });
  it('includes all probe variants G38.3/G38.4', () => {
    expect(ghover('G38.3', 'G38.3')).toContain('Probing');
    expect(ghover('G38.4', 'G38.4')).toContain('Probing');
  });
});

describe('round-2 adjacent-edge fixes', () => {
  const applyIniEdit = (text: string, offset: number, label: string): string => {
    const items = completeIni({ ini: parseIni(text), lineIndex: new LineIndex(text), text, offset, index });
    const it = items.find((i) => i.label === label)!;
    const te = it.textEdit as { range: { start: unknown; end: unknown }; newText: string };
    const li = new LineIndex(text);
    return text.slice(0, li.offsetAt(te.range.start as never)) + te.newText + text.slice(li.offsetAt(te.range.end as never));
  };

  it('#1 completeIni does not double the closing bracket', () => {
    expect(applyIniEdit('[AX]', 3, 'AXIS_X')).toBe('[AXIS_X]');
    expect(applyIniEdit('[]', 1, 'AXIS_X')).toBe('[AXIS_X]');
    expect(applyIniEdit('[AX', 3, 'AXIS_X')).toBe('[AXIS_X]'); // unclosed still gets one ]
  });

  it('#2 completeGcode does not fire inside a [ ] expression (single-letter / number cursor)', () => {
    const c = (t: string) => completeGcode(t, new LineIndex(t), t.length, index).length;
    expect(c('G1 X[g')).toBe(0);
    expect(c('[m')).toBe(0);
    expect(c('#1=[g0')).toBe(0);
    expect(c('G1 X[#1+2] G')).toBeGreaterThan(0); // after the bracket closes, codes resume
  });

  it('#3 rename rejects structurally-invalid new names', () => {
    const hal = 'net x-pos pid.0.output\n';
    const m = model(undefined, [{ uri: 'a.hal', text: hal }]);
    const at = hal.indexOf('x-pos') + 2;
    for (const bad of ['bad name', 'a=b', 'a#b', 'a[b', 'a\nb']) expect(rename(m, 'a.hal', at, bad)).toBeNull();
    expect(rename(m, 'a.hal', at, 'x-cmd')).not.toBeNull();
  });

  it('#4 find-references resolves an embedded-INI Mesa pin (no fragment conflation)', () => {
    const m = model(undefined, [{ uri: 'a.hal', text: 'net s hm2_[HM](BOARD).0.gpio.001.in\nnet s2 hm2_[HM](BOARD).0.gpio.001.in\n' }]);
    const text = 'net s hm2_[HM](BOARD).0.gpio.001.in\nnet s2 hm2_[HM](BOARD).0.gpio.001.in\n';
    const refs = references(m, 'a.hal', text.indexOf('.0.gpio') + 3);
    expect(refs.length).toBeGreaterThanOrEqual(2); // both occurrences found, not zero
  });

  it('#5 bool ON/OFF is accepted (no false type mismatch)', () => {
    const d = codes(model('[AXIS_X]\nHOME_USE_INDEX = ON\n', []), 'file:///m.ini');
    expect(d).not.toContain('ini.value.typeMismatch');
  });

  it('#6 hoverHal resolves a pin on a names=-defined instance via the model', () => {
    const hal = 'loadrt scale names=spindle-fb-rpm-scale\nsetp spindle-fb-rpm-scale.gain 2\n';
    const m = model(undefined, [{ uri: 'a.hal', text: hal }]);
    const h = hoverHal(parseHal(hal), new LineIndex(hal), hal.indexOf('.gain') + 2, index, m);
    expect(h && typeof h.contents === 'object' && 'value' in h.contents ? (h.contents as { value: string }).value : '').toContain('scale');
  });

  it('#7 no bogus bare G38 entry; G38.2 still documented', () => {
    expect(ghover('G38', 'G38')).not.toContain('Straight Probe'); // junk title gone
    expect(ghover('G38.2', 'G38.2')).toContain('Probing');
  });

  it('#13 hoverGcode preserves brackets for ## indirect named params', () => {
    expect(ghover('X##<myvar>', '##<myvar>')).toContain('#<myvar>');
  });
});

describe('round-3 edge fixes (metadata)', () => {
  it('#1 dedupes a HAL file listed twice -> no overlapping rename edits', () => {
    const hal = 'net tool-change foo.0.in\n';
    const uri = 'file:///p.hal';
    const li = new LineIndex(hal);
    const m = buildMachineModel({
      files: [
        { uri, text: hal, lineIndex: li, hal: parseHal(hal), phase: 'postgui', order: 0 },
        { uri, text: hal, lineIndex: li, hal: parseHal(hal), phase: 'postgui', order: 1 },
      ],
      index,
    });
    const edit = rename(m, uri, hal.indexOf('tool-change') + 2, 'newsig');
    expect(edit!.changes![uri].length).toBe(1); // one edit, not two overlapping
  });

  it('#3 M1 shows Program Pause, not the M100-M199 user-defined range', () => {
    expect(ghover('M1', 'M1')).toContain('Program Pause');
    expect(ghover('M1', 'M1')).not.toContain('User Defined');
  });

  it('#7 hex / hexfloat accepted for real-typed INI keys', () => {
    expect(codes(model('[AXIS_X]\nMAX_VELOCITY = 0x10\n', []), 'file:///m.ini')).not.toContain('ini.value.typeMismatch');
    expect(codes(model('[AXIS_X]\nMAX_VELOCITY = 0x1.8p3\n', []), 'file:///m.ini')).not.toContain('ini.value.typeMismatch');
  });

  it('#8 M50 hover has a non-empty doc body', () => {
    expect(index.gcodeWord('M50')?.docMd).toBeTruthy();
  });
});

describe('adoc converter (fuzz #24/#25)', () => {
  it('strips a nested index macro without leaking a stray paren', () => {
    const out = adocToMarkdown('(((spindle (HAL pins))))The text.');
    expect(out).not.toContain(')');
    expect(out).toContain('The text.');
  });
  it('resets admonition state at the closing fence', () => {
    const out = adocToMarkdown('[NOTE]\n====\ninside note\n====\nafter note');
    const afterLine = out.split('\n').find((l) => l.includes('after note')) ?? '';
    expect(afterLine.startsWith('>')).toBe(false);
  });
});
