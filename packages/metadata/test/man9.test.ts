import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseMan9 } from '../src/extractors/man9';

const FIX = path.resolve(__dirname, 'fixtures/man9');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');

describe('man9 parser', () => {
  it('parses name and summary', () => {
    const m = parseMan9(read('stepgen.9.adoc'))!;
    expect(m.name).toBe('stepgen');
    expect(m.summary).toContain('step pulse generation');
  });

  it('renders the DESCRIPTION as markdown', () => {
    const m = parseMan9(read('stepgen.9.adoc'))!;
    expect(m.descriptionMd).toBeTruthy();
    expect(m.descriptionMd!.length).toBeGreaterThan(50);
  });

  it('extracts member docs for pins', () => {
    const m = parseMan9(read('stepgen.9.adoc'))!;
    const keys = Object.keys(m.memberDocs);
    expect(keys.some((k) => k.includes('stepgen') && k.includes('counts'))).toBe(true);
  });

  it('parses the hostmot2 man page name', () => {
    const m = parseMan9(read('hostmot2.9.adoc'))!;
    expect(m.name).toBe('hostmot2');
    expect(m.descriptionMd).toBeTruthy();
  });
});
