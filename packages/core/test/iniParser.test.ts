import { describe, it, expect } from 'vitest';
import { parseIni } from '../src/ini/parser';
import { findSection, findEntries } from '../src/ini/ast';

const sample = `# a comment
[EMC]
MACHINE = Flexicam
DEBUG = 0

[HAL]
HALFILE = core.hal
HALFILE = custom.hal
POSTGUI_HALFILE = postgui.hal

[JOINT_0]
HOME_SEARCH_VEL = 20.0
INCORRECT = value # not a comment
`;

describe('INI parser', () => {
  const file = parseIni(sample);

  it('parses sections', () => {
    expect(file.sections.map((s) => s.name.text)).toEqual(['EMC', 'HAL', 'JOINT_0']);
  });

  it('value spans have correct offsets back into the text', () => {
    for (const sec of file.sections) {
      for (const e of sec.entries) {
        if (e.value) {
          expect(sample.slice(e.value.start, e.value.end)).toBe(e.value.text);
        }
        expect(sample.slice(e.key.start, e.key.end)).toBe(e.key.text);
      }
    }
  });

  it('keeps repeated keys as separate entries', () => {
    const hal = findSection(file, 'HAL')!;
    const halfiles = findEntries(hal, 'HALFILE');
    expect(halfiles.map((e) => e.value?.text)).toEqual(['core.hal', 'custom.hal']);
  });

  it('section lookup is case-insensitive', () => {
    expect(findSection(file, 'joint_0')?.name.text).toBe('JOINT_0');
  });

  it('does NOT treat a trailing # as a comment', () => {
    const j = findSection(file, 'JOINT_0')!;
    const inc = findEntries(j, 'INCORRECT')[0];
    expect(inc.value?.text).toBe('value # not a comment');
  });

  it('parses HOME_SEARCH_VEL value', () => {
    const j = findSection(file, 'JOINT_0')!;
    expect(findEntries(j, 'HOME_SEARCH_VEL')[0].value?.text).toBe('20.0');
  });

  it('captures #INCLUDE directives', () => {
    const f = parseIni('[X]\n#INCLUDE joint_0.inc\nA = 1\n');
    expect(f.includes.map((i) => i.file.text)).toEqual(['joint_0.inc']);
  });

  it('handles value continuation across backslash lines', () => {
    const f = parseIni('[APPLICATIONS]\nAPP = sim_pin \\\n  a \\\n  b\n');
    const app = findEntries(findSection(f, 'APPLICATIONS')!, 'APP')[0];
    expect(app.value?.text).toContain('sim_pin');
    expect(app.value?.text).toContain('b');
  });

  it('flags an entry before any section', () => {
    const f = parseIni('KEY = 1\n[S]\nA = 2\n');
    expect(f.orphanEntries.length).toBe(1);
    expect(f.problems.some((p) => p.code === 'ini.syntax.entryOutsideSection')).toBe(true);
  });

  it('flags a malformed line', () => {
    const f = parseIni('[S]\nthis is not valid\n');
    expect(f.problems.some((p) => p.code === 'ini.syntax.malformedLine')).toBe(true);
  });

  it('reports a section end that spans to the next section', () => {
    const emc = findSection(file, 'EMC')!;
    const hal = findSection(file, 'HAL')!;
    expect(emc.end).toBeLessThanOrEqual(hal.start);
  });
});
