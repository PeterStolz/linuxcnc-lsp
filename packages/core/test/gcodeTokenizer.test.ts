import { describe, it, expect } from 'vitest';
import { tokenizeGcode, GcodeTokenKind } from '../src/index';

const kinds = (s: string) => tokenizeGcode(s).map((t) => t.kind);
const words = (s: string) => tokenizeGcode(s).filter((t) => t.kind === GcodeTokenKind.Word);

describe('tokenizeGcode', () => {
  it('splits address words with letter/value/code', () => {
    const ws = words('G1 X1.5 Y-2.3 F100');
    expect(ws.map((w) => w.code)).toEqual(['G1', undefined, undefined, 'F']);
    expect(ws.map((w) => w.letter)).toEqual(['G', 'X', 'Y', 'F']);
    expect(ws.find((w) => w.letter === 'Y')?.value).toBe('-2.3');
  });

  it('normalizes code numbers (G01 -> G1, G38.20 -> G38.2)', () => {
    expect(words('G01')[0].code).toBe('G1');
    expect(words('G38.2')[0].code).toBe('G38.2');
    expect(words('M03')[0].code).toBe('M3');
  });

  it('recognizes both comment styles', () => {
    expect(kinds('G0 (rapid) ; to home')).toEqual([
      GcodeTokenKind.Word, GcodeTokenKind.Comment, GcodeTokenKind.Comment,
    ]);
  });

  it('tokenizes parameters (named, numbered, global) and assignment', () => {
    const t = tokenizeGcode('#<x> = #5220');
    expect(t[0].kind).toBe(GcodeTokenKind.Param);
    expect(t[0].text).toBe('#<x>');
    expect(t[1].kind).toBe(GcodeTokenKind.Operator);
    expect(t[2].text).toBe('#5220');
  });

  it('tokenizes O-words and their keywords', () => {
    const t = tokenizeGcode('o100 sub');
    expect(t[0].kind).toBe(GcodeTokenKind.Oword);
    expect(t[1].kind).toBe(GcodeTokenKind.OKeyword);
    expect(t[1].text).toBe('sub');
    const t2 = tokenizeGcode('o<probe> call [1]');
    expect(t2[0].text).toBe('o<probe>');
    expect(t2[1].text).toBe('call');
  });

  it('does not parse function names inside [] as address words', () => {
    // SIN must not become an "S" word with value "IN".
    const ws = words('G1 X[SIN[#1]]');
    expect(ws.map((w) => w.letter)).toEqual(['G', 'X']); // no spurious S word
  });
});
