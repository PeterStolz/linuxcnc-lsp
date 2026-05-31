import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractIniConfig, extractHoming } from '../src/extractors/iniDocs';
import { adocToMarkdown } from '../src/adoc';

const FIX = path.resolve(__dirname, 'fixtures/adoc');
const iniConfig = fs.readFileSync(path.join(FIX, 'ini-config.adoc'), 'utf8');
const iniHoming = fs.readFileSync(path.join(FIX, 'ini-homing.adoc'), 'utf8');

describe('adoc -> markdown', () => {
  it('converts headings, bold and strips index macros', () => {
    const md = adocToMarkdown('== Title(((idx)))\nUse *bold* and `code` here.');
    expect(md).toContain('## Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('`code`');
    expect(md).not.toContain('(((');
  });

  it('leaves existing markdown bold intact', () => {
    expect(adocToMarkdown('a **strong** word')).toContain('**strong**');
  });

  it('converts links', () => {
    expect(adocToMarkdown('see https://linuxcnc.org[the site]')).toContain('[the site](https://linuxcnc.org)');
  });
});

describe('extractIniConfig', () => {
  const { sections, consumedKeys } = extractIniConfig(iniConfig);

  it('finds the standard sections', () => {
    for (const s of ['EMC', 'DISPLAY', 'HAL', 'TRAJ', 'EMCIO', 'RS274NGC']) {
      expect(sections[s], s).toBeDefined();
    }
  });

  it('marks instanced sections', () => {
    expect(sections['JOINT_<num>']?.instanced).toBe(true);
    expect(sections['AXIS_<letter>']?.instanced).toBe(true);
  });

  it('extracts TRAJ keys with types and docs', () => {
    const traj = sections['TRAJ'];
    expect(traj.keys['coordinates']).toBeDefined();
    expect(traj.keys['max_linear_velocity']?.doc).toContain('maximum velocity');
    expect(traj.keys['arc_blend_enable']?.type).toBe('bool');
  });

  it('strips index macros before extracting the (type) for a key', () => {
    const k = sections['TRAJ'].keys['max_linear_velocity'];
    // (((MAX VELOCITY))) must not leak into the type or the doc.
    expect(k?.type ?? '').not.toContain('MAX VELOCITY');
    expect(k?.doc?.startsWith(')')).toBe(false);
  });

  it('builds a runtime-consumed key list', () => {
    expect(consumedKeys).toContain('MACHINE');
    expect(consumedKeys).toContain('COORDINATES');
    expect(consumedKeys.length).toBeGreaterThan(50);
  });
});

describe('extractHoming', () => {
  const homing = extractHoming(iniHoming);

  it('extracts the documented homing keys', () => {
    for (const k of ['HOME_SEARCH_VEL', 'HOME_LATCH_VEL', 'HOME_OFFSET', 'HOME_SEQUENCE', 'HOME_USE_INDEX']) {
      expect(homing[k], k).toBeDefined();
    }
  });

  it('renders HOME_SEARCH_VEL docs as markdown prose', () => {
    expect(homing['HOME_SEARCH_VEL']).toContain('machine-units per second');
    expect(homing['HOME_SEARCH_VEL']).not.toContain('(((');
  });

  it('does not capture prose headings as keys', () => {
    expect(homing['Immediate Homing']).toBeUndefined();
  });
});
