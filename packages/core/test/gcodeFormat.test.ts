import { describe, it, expect } from 'vitest';
import { TextEdit } from 'vscode-languageserver-types';
import { parseGcode, formatGcode, LineIndex } from '../src/index';

function apply(text: string, edits: TextEdit[]): string {
  const li = new LineIndex(text);
  const off = edits
    .map((e) => ({ s: li.offsetAt(e.range.start), e: li.offsetAt(e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s);
  let out = text;
  for (const ed of off) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
  return out;
}

const fmt = (text: string, tabSize = 2, insertSpaces = true): string => {
  const edits = formatGcode(new LineIndex(text), parseGcode(text), { tabSize, insertSpaces });
  return apply(text, edits);
};

describe('formatGcode', () => {
  it('indents a subroutine body by one level', () => {
    const src = 'o<p> sub\nG1 X1\no<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  G1 X1\no<p> endsub\n');
  });

  it('indents nested control-flow blocks', () => {
    const src = 'o1 if [1]\no2 while [1]\nG1 X1\no2 endwhile\no1 endif\n';
    expect(fmt(src)).toBe('o1 if [1]\n  o2 while [1]\n    G1 X1\n  o2 endwhile\no1 endif\n');
  });

  it('dedents the do-while terminator', () => {
    const src = 'o2 do\nG1 X1\no2 while [#1 LT 5]\n';
    expect(fmt(src)).toBe('o2 do\n  G1 X1\no2 while [#1 LT 5]\n');
  });

  it('re-indents wrongly-indented input', () => {
    const src = '   o<p> sub\n        G1 X1\n   o<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  G1 X1\no<p> endsub\n');
  });

  it('honors tabs when insertSpaces is false', () => {
    const src = 'o<p> sub\nG1 X1\no<p> endsub\n';
    expect(fmt(src, 4, false)).toBe('o<p> sub\n\tG1 X1\no<p> endsub\n');
  });

  it('trims trailing whitespace and blank-line whitespace', () => {
    const src = 'G0 X1   \n   \nG1 Y2\n';
    expect(fmt(src)).toBe('G0 X1\n\nG1 Y2\n');
  });

  it('is idempotent (formatting the result yields no further edits)', () => {
    const src = 'o<p> sub\n  o1 if [1]\n  G1 X1\n  o1 endif\no<p> endsub\n';
    const once = fmt(src);
    const edits2 = formatGcode(new LineIndex(once), parseGcode(once), { tabSize: 2, insertSpaces: true });
    expect(edits2).toEqual([]);
  });

  it('leaves an already-correct flat program unchanged', () => {
    const src = 'G21\nG90\nG0 X0 Y0\nM2\n';
    const edits = formatGcode(new LineIndex(src), parseGcode(src), { tabSize: 2, insertSpaces: true });
    expect(edits).toEqual([]);
  });
});
