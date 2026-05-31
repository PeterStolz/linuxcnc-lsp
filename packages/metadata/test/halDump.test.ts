import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseHalDump } from '../src/extractors/halDump';

const RAW = path.resolve(__dirname, '../data/raw');
const dumpText =
  fs.readFileSync(path.join(RAW, 'hal-dump.txt'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(RAW, 'hal-dump-extra.txt'), 'utf8');

const comps = parseHalDump(dumpText);
const byName = new Map(comps.map((c) => [c.name, c]));

describe('HAL dump parser', () => {
  it('parses many components', () => {
    expect(comps.length).toBeGreaterThan(150);
  });

  it('extracts instance-relative pin suffixes for scale', () => {
    const scale = byName.get('scale')!;
    expect(scale).toBeDefined();
    expect(scale.absolute).toBe(false);
    const pinNames = scale.pins.map((p) => p.name).sort();
    expect(pinNames).toContain('gain');
    expect(pinNames).toContain('in');
    expect(pinNames).toContain('out');
    // auto-generated timing pin captured from ground truth
    expect(pinNames).toContain('time');
    // none should still carry the instance prefix
    expect(scale.pins.every((p) => !p.name.startsWith('scale.'))).toBe(true);
    const gain = scale.pins.find((p) => p.name === 'gain')!;
    expect(gain.type).toBe('float');
    expect(gain.dir).toBe('in');
  });

  it('captures params with rw/ro direction', () => {
    const scale = byName.get('scale')!;
    const tmax = scale.params.find((p) => p.name === 'tmax');
    expect(tmax?.dir).toBe('rw');
    const inc = scale.params.find((p) => p.name === 'tmax-increased');
    expect(inc?.dir).toBe('ro');
  });

  it('strips the instance from pid function names', () => {
    const pid = byName.get('pid');
    expect(pid).toBeDefined();
    // pid functions are pid.N.do-pid-calcs -> suffix do-pid-calcs
    expect(pid!.functions.map((f) => f.name)).toContain('do-pid-calcs');
  });

  it('models motion with absolute joint.N / axis.L templates', () => {
    const motion = byName.get('motion')!;
    expect(motion).toBeDefined();
    expect(motion.absolute).toBe(true);
    const names = motion.pins.map((p) => p.name);
    expect(names).toContain('joint.N.home-sw-in');
    expect(names.some((n) => n.startsWith('axis.L.'))).toBe(true);
    expect(names.some((n) => n.startsWith('motion.'))).toBe(true);
    // indices collapsed to N -> no bare joint.0 templates remain
    expect(names.every((n) => !/joint\.\d/.test(n))).toBe(true);
  });

  it('captures stepgen and pwmgen from the extra dump', () => {
    expect(byName.get('stepgen')?.pins.map((p) => p.name)).toContain('position-cmd');
    expect(byName.has('pwmgen')).toBe(true);
  });

  it('captures simple gates like and2', () => {
    const and2 = byName.get('and2')!;
    expect(and2.pins.map((p) => p.name).sort()).toEqual(
      expect.arrayContaining(['in0', 'in1', 'out']),
    );
    expect(and2.functions.map((f) => f.name)).toContain(''); // bare instance function
  });
});
