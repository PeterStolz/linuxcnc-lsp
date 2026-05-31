import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseCompFile } from '../src/extractors/comp';

const FIX = path.resolve(__dirname, 'fixtures/comp');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');

describe('.comp parser', () => {
  it('parses component name and description', () => {
    const c = parseCompFile(read('and2.comp'))!;
    expect(c.name).toBe('and2');
    expect(c.description).toContain('AND');
  });

  it('parses pins with direction, type and doc strings', () => {
    const c = parseCompFile(read('and2.comp'))!;
    const out = c.pins.find((p) => p.halname === 'out')!;
    expect(out.dir).toBe('out');
    expect(out.type).toBe('bit');
    const in0 = c.pins.find((p) => p.halname === 'in0')!;
    expect(in0.dir).toBe('in');
    expect(in0.doc).toBeTruthy();
  });

  it('parses params with rw/ro and defaults absent from doc', () => {
    const c = parseCompFile(read('sum2.comp'))!;
    const gain0 = c.params.find((p) => p.halname === 'gain0')!;
    expect(gain0.dir).toBe('rw');
    expect(gain0.type).toBe('float');
    // the out pin has the descriptive doc string
    const out = c.pins.find((p) => p.halname === 'out')!;
    expect(out.doc).toContain('in0 * gain0');
  });

  it('captures see_also, author, license', () => {
    const c = parseCompFile(read('sum2.comp'))!;
    expect(c.seeAlso).toContain('scaled_s32_sums');
    expect(c.author).toContain('Jeff Epler');
    expect(c.license).toBe('GPL');
  });

  it('parses functions, mapping _ to empty suffix', () => {
    const c = parseCompFile(read('and2.comp'))!;
    expect(c.functions.map((f) => f.name)).toContain('');
  });

  it('handles array pins by stripping the [..] spec from halname', () => {
    const c = parseCompFile(read('mux2.comp'))!;
    expect(c.pins.every((p) => !p.halname.includes('['))).toBe(true);
  });
});
