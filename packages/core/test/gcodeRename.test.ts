// Pure G-code rename/reference helpers used by the server's rename + find-references
// handlers. Covers the editable-name range, name validation, and the numbered-sub
// gate (numbered O-words are file-local and must never match across files).
import { describe, it, expect } from 'vitest';
import { Range } from 'vscode-languageserver-types';
import {
  parseGcode, LineIndex,
  gcodeRenameTarget, owordNameRange, isValidOwordName,
  gcodeRenameRangesInFile, gcodeReferenceRangesInFile,
} from '../src/index';

const text = (s: string, li: LineIndex, r: Range): string =>
  s.slice(li.offsetAt(r.start), li.offsetAt(r.end));

describe('gcode rename helpers', () => {
  it('gcodeRenameTarget picks a named o-word, not a numbered/computed one', () => {
    const named = 'o<probe> sub\nG1 X1\no<probe> endsub\n';
    const t = gcodeRenameTarget(parseGcode(named), named.indexOf('probe') + 1);
    expect(t?.form).toBe('named');
    expect(t?.name).toBe('probe');

    const numbered = 'o100 sub\nG1 X1\no100 endsub\n';
    expect(gcodeRenameTarget(parseGcode(numbered), numbered.indexOf('100') + 1)).toBeUndefined();
  });

  it('owordNameRange covers only the inner name (not the o<...> wrapper)', () => {
    const src = 'o<probe> sub\no<probe> endsub\n';
    const li = new LineIndex(src);
    const t = gcodeRenameTarget(parseGcode(src), src.indexOf('probe') + 1)!;
    expect(text(src, li, owordNameRange(t, li)!)).toBe('probe');
  });

  it('gcodeRenameRangesInFile returns the inner-name span of every occurrence of the key', () => {
    const src = 'o<probe> sub\no<probe> call\no<probe> endsub\no<other> sub\no<other> endsub\n';
    const li = new LineIndex(src);
    const ranges = gcodeRenameRangesInFile(parseGcode(src), li, 'probe');
    expect(ranges.length).toBe(3);
    expect(ranges.every((r) => text(src, li, r) === 'probe')).toBe(true);
  });

  it('isValidOwordName rejects separators, brackets, whitespace, and reserved keywords', () => {
    expect(isValidOwordName('probe')).toBe(true);
    expect(isValidOwordName('probe_2')).toBe(true);
    expect(isValidOwordName('')).toBe(false);
    expect(isValidOwordName('a/b')).toBe(false);
    expect(isValidOwordName('a\\b')).toBe(false);
    expect(isValidOwordName('a b')).toBe(false);
    expect(isValidOwordName('<x>')).toBe(false);
    expect(isValidOwordName('sub')).toBe(false);
    expect(isValidOwordName('WHILE')).toBe(false);
  });

  it('gcodeReferenceRangesInFile excludes numbered (file-local) subs — S1', () => {
    const numbered = 'o100 sub\no100 call\no100 endsub\n';
    const li1 = new LineIndex(numbered);
    expect(gcodeReferenceRangesInFile(parseGcode(numbered), li1, '100')).toEqual([]);

    const named = 'o<p> sub\no<p> call\no<p> endsub\n';
    const li2 = new LineIndex(named);
    expect(gcodeReferenceRangesInFile(parseGcode(named), li2, 'p').length).toBe(3);
    // includeDecl=false drops the `sub` declaration.
    expect(gcodeReferenceRangesInFile(parseGcode(named), li2, 'p', false).length).toBe(2);
  });
});
