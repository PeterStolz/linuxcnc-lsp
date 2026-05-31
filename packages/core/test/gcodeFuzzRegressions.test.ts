import { describe, it, expect } from 'vitest';
import { parseGcode } from '../src/index';

// Semantic regressions distilled from the persona fuzz sweep (edge-structural /
// chaos personas). Each locks a tricky O-word matcher behavior.
const codes = (text: string): string[] =>
  parseGcode(text).problems.map((p) => p.code.replace('gcode.oword.', '').replace('gcode.', ''));

describe('gcode fuzz regressions — else/elseif chains', () => {
  it('flags a duplicate else exactly once', () => {
    expect(codes('o100 if [1]\no100 else\no100 else\no100 endif\n')).toEqual(['duplicateElse']);
  });

  it('flags an elseif that follows an else (LinuxCNC rejects it)', () => {
    expect(codes('o100 if [1]\no100 else\no100 elseif [2]\no100 endif\n')).toEqual(['duplicateElse']);
  });

  it('accepts any number of elseif branches before the else', () => {
    expect(codes('o1 if [1]\no1 elseif [2]\no1 elseif [3]\no1 else\no1 endif\n')).toEqual([]);
  });
});

describe('gcode fuzz regressions — do/while ambiguity', () => {
  it('a while immediately after a matching do is the loop terminator (clean)', () => {
    const p = parseGcode('o1 do\nG1 X1\no1 while [#1 LT 5]\n');
    expect(p.problems).toEqual([]);
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].kind).toBe('do');
    expect(p.blocks[0].close).toBeDefined();
  });

  it('nested do-loops with the same label match innermost-first (clean)', () => {
    expect(codes('o100 do\no100 do\no100 while [#2 LT 3]\no100 while [#1 LT 5]\n')).toEqual([]);
  });

  it('a top-tested while loop followed by a same-label do-loop is clean', () => {
    expect(codes('o100 while [#1 LT 5]\no100 endwhile\no100 do\no100 while [#2 LT 3]\n')).toEqual([]);
  });

  it('flags a do/while label mismatch', () => {
    expect(codes('o100 do\no200 while [#1 LT 5]\n')).toEqual(['labelMismatch']);
  });
});

describe('gcode fuzz regressions — label identity', () => {
  it('numbered labels match modulo leading zeros (o007 == o7)', () => {
    const p = parseGcode('o007 sub\nG1 X1\no7 endsub\n');
    expect(p.problems).toEqual([]);
    expect(p.subs).toHaveLength(1);
    expect(p.subs[0].key).toBe('7');
  });

  it('named labels match case-insensitively (O<Foo> == o<foo>)', () => {
    const p = parseGcode('O<Foo> sub\nG1 X1\no<foo> endsub\n');
    expect(p.problems).toEqual([]);
    expect(p.subs[0].key).toBe('foo');
  });

  it('never flags a dynamic (computed/indirect) label', () => {
    expect(codes('o[#1+2] call\n')).toEqual([]);
    expect(codes('o#5 call\n')).toEqual([]);
  });
});

describe('gcode fuzz regressions — chaos robustness', () => {
  it('handles thousands of unbalanced openers without quadratic blowup', () => {
    const t0 = performance.now();
    const text = Array.from({ length: 5000 }, () => 'o1 sub').join('\n');
    const p = parseGcode(text);
    expect(performance.now() - t0).toBeLessThan(1000);
    // every sub after the first is a nested + duplicate, and all are unclosed
    expect(p.problems.some((x) => x.code === 'gcode.oword.unclosed')).toBe(true);
    expect(p.lineDepth[p.lineDepth.length - 1]).toBeLessThanOrEqual(5000);
  });

  it('handles deep nesting and bare terminators without going negative', () => {
    const p = parseGcode(Array.from({ length: 2000 }, () => 'o1 endif').join('\n'));
    expect(p.lineDepth.every((d) => d >= 0)).toBe(true);
    expect(p.problems.every((x) => x.code === 'gcode.oword.unmatchedClose')).toBe(true);
  });
});
