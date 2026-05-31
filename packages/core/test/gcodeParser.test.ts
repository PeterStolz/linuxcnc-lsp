import { describe, it, expect } from 'vitest';
import { parseGcode, classifyOword } from '../src/index';

describe('classifyOword', () => {
  it('classifies named labels (lowercased key, original name preserved)', () => {
    const r = classifyOword('o<Probe>', 0, 8);
    expect(r.form).toBe('named');
    expect(r.name).toBe('Probe');
    expect(r.key).toBe('probe');
  });
  it('classifies numbered labels and strips leading zeros', () => {
    expect(classifyOword('o0100', 0, 5).key).toBe('100');
    expect(classifyOword('O7', 0, 2).key).toBe('7');
  });
  it('marks computed / indirect labels as dynamic (no key)', () => {
    expect(classifyOword('o[#1]', 0, 5).form).toBe('computed');
    expect(classifyOword('o[#1]', 0, 5).key).toBeUndefined();
    expect(classifyOword('o#5', 0, 3).form).toBe('indirect');
    expect(classifyOword('o#5', 0, 3).key).toBeUndefined();
  });
});

describe('parseGcode — subroutines', () => {
  it('matches a named sub/endsub pair', () => {
    const p = parseGcode('o<probe> sub\nG1 X1\no<probe> endsub\n');
    expect(p.problems).toEqual([]);
    expect(p.subs).toHaveLength(1);
    expect(p.subs[0].key).toBe('probe');
    expect(p.subs[0].block.close).toBeDefined();
    expect(p.blocks).toHaveLength(1);
  });

  it('collects call statements', () => {
    const p = parseGcode('o<probe> call [1] [2]\n');
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].oword.key).toBe('probe');
  });

  it('flags a duplicate subroutine definition', () => {
    const p = parseGcode('o<a> sub\no<a> endsub\no<a> sub\no<a> endsub\n');
    expect(p.subs).toHaveLength(2);
    expect(p.problems.some((x) => x.code === 'gcode.oword.duplicateSub')).toBe(true);
  });

  it('flags a subroutine defined inside another subroutine', () => {
    const p = parseGcode('o<a> sub\no<b> sub\no<b> endsub\no<a> endsub\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.nestedSub')).toBe(true);
  });
});

describe('parseGcode — control flow nesting', () => {
  it('matches if/else/endif and computes indentation depth', () => {
    const p = parseGcode('o1 if [#1 GT 0]\nG1 X1\no1 else\nG1 X-1\no1 endif\n');
    expect(p.problems).toEqual([]);
    expect(p.lineDepth.slice(0, 5)).toEqual([0, 1, 0, 1, 0]);
  });

  it('treats `while` after `do` as the loop terminator (do-while)', () => {
    const p = parseGcode('o2 do\nG1 X1\no2 while [#1 LT 5]\n');
    expect(p.problems).toEqual([]);
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].kind).toBe('do');
    expect(p.blocks[0].close).toBeDefined();
    expect(p.lineDepth.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('treats a standalone `while` as a top-tested loop opener', () => {
    const p = parseGcode('o3 while [#1 LT 5]\nG1 X1\no3 endwhile\n');
    expect(p.problems).toEqual([]);
    expect(p.blocks[0].kind).toBe('while');
    expect(p.lineDepth.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('handles repeat/endrepeat', () => {
    const p = parseGcode('o4 repeat [5]\nG1 X1\no4 endrepeat\n');
    expect(p.problems).toEqual([]);
    expect(p.blocks[0].kind).toBe('repeat');
  });

  it('nests blocks and indents accordingly', () => {
    const src = 'o<s> sub\no1 if [1]\no2 while [1]\nG1\no2 endwhile\no1 endif\no<s> endsub\n';
    const p = parseGcode(src);
    expect(p.problems).toEqual([]);
    expect(p.lineDepth.slice(0, 7)).toEqual([0, 1, 2, 3, 2, 1, 0]);
  });
});

describe('parseGcode — structural problems', () => {
  it('flags an unmatched terminator', () => {
    const p = parseGcode('o1 endif\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.unmatchedClose')).toBe(true);
  });

  it('flags an unclosed block at EOF', () => {
    const p = parseGcode('o<a> sub\nG1 X1\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.unclosed')).toBe(true);
  });

  it('flags a label mismatch on the terminator', () => {
    const p = parseGcode('o1 sub\no2 endsub\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.labelMismatch')).toBe(true);
  });

  it('flags else without an enclosing if', () => {
    const p = parseGcode('o1 else\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.unmatchedClose')).toBe(true);
  });

  it('flags a duplicate else', () => {
    const p = parseGcode('o1 if [1]\no1 else\no1 else\no1 endif\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.duplicateElse')).toBe(true);
  });

  it('flags return outside a subroutine and break outside a loop', () => {
    expect(parseGcode('o1 return\n').problems.some((x) => x.code === 'gcode.oword.returnOutsideSub')).toBe(true);
    expect(parseGcode('o1 break\n').problems.some((x) => x.code === 'gcode.oword.controlOutsideLoop')).toBe(true);
  });

  it('does not flag return inside a sub or break inside a loop', () => {
    expect(parseGcode('o<a> sub\no1 return\no<a> endsub\n').problems).toEqual([]);
    expect(parseGcode('o2 while [1]\no2 break\no2 endwhile\n').problems).toEqual([]);
  });

  it('flags an O-word with no keyword', () => {
    const p = parseGcode('o100\n');
    expect(p.problems.some((x) => x.code === 'gcode.oword.missingKeyword')).toBe(true);
  });

  it('does not flag a plain G-code program', () => {
    const p = parseGcode('G21\nG90\nG0 X0 Y0\nG1 X1 Y1 F100\nM2\n');
    expect(p.problems).toEqual([]);
    expect(p.lineDepth.every((d) => d === 0)).toBe(true);
  });

  it('does not statically flag dynamic (computed/indirect) labels', () => {
    // A computed-label call cannot be matched, so no missing-keyword/unclosed noise.
    const p = parseGcode('o[#1] call\n');
    expect(p.calls).toHaveLength(1);
    expect(p.problems).toEqual([]);
  });
});
