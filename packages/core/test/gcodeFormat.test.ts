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

interface Opts { tabSize?: number; insertSpaces?: boolean; trim?: boolean }

const editsOf = (text: string, o: Opts = {}): TextEdit[] =>
  formatGcode(new LineIndex(text), parseGcode(text), {
    tabSize: o.tabSize ?? 2,
    insertSpaces: o.insertSpaces ?? true,
    trimTrailingWhitespace: o.trim ?? false,
  });

const fmt = (text: string, o: Opts = {}): string => apply(text, editsOf(text, o));

/** Lines split for per-line invariant checks, ignoring the final newline. */
const lines = (s: string): string[] => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
const stripLead = (l: string): string => l.replace(/^[ \t]+/, '');

describe('formatGcode — indentation (unchanged behavior)', () => {
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
    expect(fmt(src, { tabSize: 4, insertSpaces: false })).toBe('o<p> sub\n\tG1 X1\no<p> endsub\n');
  });

  it('honors a custom indent width', () => {
    const src = 'o<p> sub\nG1 X1\no<p> endsub\n';
    expect(fmt(src, { tabSize: 4 })).toBe('o<p> sub\n    G1 X1\no<p> endsub\n');
  });

  it('leaves an already-correct flat program unchanged (zero edits)', () => {
    const src = 'G21\nG90\nG0 X0 Y0\nM2\n';
    expect(editsOf(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #11: the formatter must not rewrite whitespace the user did not ask it
// to touch. Default (no trim flag) preserves trailing + blank-line whitespace.
// ---------------------------------------------------------------------------
describe('formatGcode — default preserves whitespace (issue #11)', () => {
  it('leaves a blank-but-spaced line byte-for-byte (the reported bug)', () => {
    const src = 'G0 X1\n   \nG1 Y2\n';
    expect(fmt(src)).toBe(src);
    expect(editsOf(src)).toEqual([]);
  });

  it('preserves trailing whitespace on a content line', () => {
    const src = 'G0 X1   \nG1 Y2\n';
    expect(fmt(src)).toBe(src);
    expect(editsOf(src)).toEqual([]);
  });

  it('preserves tab-only and mixed-whitespace blank lines', () => {
    const src = 'G0 X1\n\t\n \t \nG1 Y2\n';
    expect(fmt(src)).toBe(src);
    expect(editsOf(src)).toEqual([]);
  });

  it('still fixes indentation while preserving trailing/blank whitespace', () => {
    // Body needs indenting; the spaced blank line and the trailing spaces on the
    // body line must survive untouched.
    const src = 'o<p> sub\nG1 X1  \n   \no<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  G1 X1  \n   \no<p> endsub\n');
  });

  it('preserves trailing whitespace even on a line whose indent is rewritten', () => {
    const src = '        G1 X1   \n';
    // depth 0 -> indent removed, but the trailing spaces stay.
    expect(fmt(src)).toBe('G1 X1   \n');
  });

  it('preserves a spaced blank line nested inside a block', () => {
    const src = 'o<p> sub\no1 if [1]\nG1 X1\n      \no1 endif\no<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  o1 if [1]\n    G1 X1\n      \n  o1 endif\no<p> endsub\n');
  });

  it('does not treat a non-breaking space as trimmable whitespace', () => {
    const src = 'G0 X1\n \nG1 Y2\n'; // U+00A0 is content, not [ \t]
    expect(fmt(src)).toBe(src);
    expect(editsOf(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When the client asks to trim (files.trimTrailingWhitespace = true), the
// formatter trims uniformly — trailing whitespace on content lines AND
// whitespace-only lines — matching VS Code's own save behavior (option A).
// ---------------------------------------------------------------------------
describe('formatGcode — trimTrailingWhitespace:true', () => {
  it('trims trailing whitespace on content lines', () => {
    const src = 'G0 X1   \nG1 Y2\n';
    expect(fmt(src, { trim: true })).toBe('G0 X1\nG1 Y2\n');
  });

  it('empties whitespace-only lines (uniform with content lines)', () => {
    const src = 'G0 X1\n   \nG1 Y2\n';
    expect(fmt(src, { trim: true })).toBe('G0 X1\n\nG1 Y2\n');
  });

  it('trims and indents together', () => {
    const src = 'o<p> sub\nG1 X1  \n   \no<p> endsub\n';
    expect(fmt(src, { trim: true })).toBe('o<p> sub\n  G1 X1\n\no<p> endsub\n');
  });

  it('trims tab and mixed trailing whitespace', () => {
    const src = 'G0 X1\t\nG1 Y2 \t \n';
    expect(fmt(src, { trim: true })).toBe('G0 X1\nG1 Y2\n');
  });
});

// ---------------------------------------------------------------------------
// Adversarial structural cases that must never lose data or churn extra bytes.
// ---------------------------------------------------------------------------
describe('formatGcode — adversarial structure', () => {
  it('handles CRLF line endings without touching the \\r\\n or trailing spaces', () => {
    const src = 'o<p> sub\r\nG1 X1  \r\n   \r\no<p> endsub\r\n';
    // Indent fixed; \r\n preserved; trailing/blank whitespace preserved (trim off).
    expect(fmt(src)).toBe('o<p> sub\r\n  G1 X1  \r\n   \r\no<p> endsub\r\n');
  });

  it('trims under CRLF when asked, keeping \\r\\n', () => {
    const src = 'G1 X1  \r\n   \r\n';
    expect(fmt(src, { trim: true })).toBe('G1 X1\r\n\r\n');
  });

  it('handles a file with no trailing newline', () => {
    const src = 'o<p> sub\nG1 X1';
    expect(fmt(src)).toBe('o<p> sub\n  G1 X1');
  });

  it('does not indent a comment-only line oddly (treated as content)', () => {
    const src = 'o<p> sub\n(just a comment)  \no<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  (just a comment)  \no<p> endsub\n');
  });

  it('leaves a leading block-delete slash as the line content', () => {
    // The "/" is content: it gets the block indent but is never stripped/moved
    // relative to the rest of the line, and nothing after it is rewritten.
    const src = 'o<p> sub\n/G1 X1  \no<p> endsub\n';
    expect(fmt(src)).toBe('o<p> sub\n  /G1 X1  \no<p> endsub\n');
  });

  it('preserves a trailing-whitespace-only last line', () => {
    const src = 'G0 X1\n   ';
    expect(fmt(src)).toBe(src);
    expect(editsOf(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants over a corpus of nasty inputs × every settings combo.
// ---------------------------------------------------------------------------
const CORPUS: string[] = [
  '',
  '\n',
  '   \n',
  'G0 X1\n   \nG1 Y2\n',
  'G0 X1   \n\t\n \t \nM2\n',
  'o<p> sub\nG1 X1  \n   \no<p> endsub\n',
  'o1 if [1]\no2 while [1]\nG1 X1   \n   \no2 endwhile\no1 endif\n',
  '   o<p> sub\n        G1 X1   \n   o<p> endsub\n',
  'o<p> sub\r\nG1 X1  \r\n   \r\no<p> endsub\r\n',
  '/G1 X1  \n(comment)  \nN10 G0 X0  \n',
  'G0 X1', // no trailing newline
  'o2 do\nG1 X1\no2 while [#1 LT 5]\n',
];

const SETTINGS: Opts[] = [
  { trim: false, insertSpaces: true, tabSize: 2 },
  { trim: true, insertSpaces: true, tabSize: 2 },
  { trim: false, insertSpaces: true, tabSize: 4 },
  { trim: false, insertSpaces: false, tabSize: 4 },
  { trim: true, insertSpaces: false, tabSize: 4 },
];

describe('formatGcode — invariants across corpus × settings', () => {
  for (const [si, opts] of SETTINGS.entries()) {
    for (const [ci, src] of CORPUS.entries()) {
      const tag = `settings#${si} input#${ci}`;

      it(`is idempotent (${tag})`, () => {
        const once = fmt(src, opts);
        expect(editsOf(once, opts)).toEqual([]);
        expect(fmt(once, opts)).toBe(once);
      });

      it(`never drops, reorders, or rewrites non-leading content (${tag})`, () => {
        // The only thing the formatter may change on any line is its leading
        // whitespace (indent) and — only when trimming — its trailing whitespace.
        const inL = lines(src);
        const outL = lines(fmt(src, opts));
        expect(outL.length).toBe(inL.length);
        for (let i = 0; i < inL.length; i++) {
          const a = stripLead(inL[i]);
          const b = stripLead(outL[i]);
          if (opts.trim) {
            expect(b.replace(/[ \t]+$/, '')).toBe(a.replace(/[ \t]+$/, ''));
            expect(b).toBe(b.replace(/[ \t]+$/, '')); // fully trimmed
          } else {
            expect(b).toBe(a); // byte-identical apart from leading indent
          }
        }
      });
    }
  }

  it('trim-off mode changes nothing but leading indentation (corpus-wide)', () => {
    for (const src of CORPUS) {
      const before = lines(src).map(stripLead).join('\n');
      const after = lines(fmt(src, { trim: false })).map(stripLead).join('\n');
      expect(after).toBe(before);
    }
  });
});
