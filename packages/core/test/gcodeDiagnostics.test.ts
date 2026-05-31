import { describe, it, expect } from 'vitest';
import {
  parseGcode, LineIndex, DiagnosticSeverity,
  diagnoseGcodeIntraFile, diagnoseGcodeUnresolvedCalls,
} from '../src/index';
import type { OStatement } from '../src/index';

const diag = (text: string, overrides?: Record<string, 'off' | 'error' | 'warning' | 'hint' | 'information'>) =>
  diagnoseGcodeIntraFile(text, parseGcode(text), new LineIndex(text), { overrides });

describe('diagnoseGcodeIntraFile', () => {
  it('reports an unmatched terminator as an Error', () => {
    const d = diag('o1 endif\n');
    const hit = d.find((x) => x.code === 'gcode.oword.unmatchedClose');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe(DiagnosticSeverity.Error);
    expect(hit!.source).toBe('linuxcnc');
  });

  it('reports unclosed blocks and label mismatches', () => {
    expect(diag('o<a> sub\n').some((x) => x.code === 'gcode.oword.unclosed')).toBe(true);
    expect(diag('o1 sub\no2 endsub\n').some((x) => x.code === 'gcode.oword.labelMismatch')).toBe(true);
  });

  it('is clean for a well-formed program', () => {
    expect(diag('o<a> sub\no1 if [1]\nG1 X1\no1 endif\no<a> endsub\no<a> call\n')).toEqual([]);
  });

  it('respects a per-rule override (off)', () => {
    expect(diag('o1 endif\n', { 'gcode.oword.unmatchedClose': 'off' })).toEqual([]);
  });

  it('respects an inline disable-line comment', () => {
    const text = 'o1 endif ; linuxcnc-lsp-disable-line gcode.oword.unmatchedClose\n';
    expect(diag(text)).toEqual([]);
  });
});

describe('diagnoseGcodeUnresolvedCalls', () => {
  const run = (text: string, isResolved: (c: OStatement) => boolean) =>
    diagnoseGcodeUnresolvedCalls(text, parseGcode(text), new LineIndex(text), isResolved);

  it('flags a call that resolves nowhere', () => {
    const d = run('o<missing> call\n', () => false);
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe('gcode.call.unknownSub');
    expect(d[0].severity).toBe(DiagnosticSeverity.Hint);
  });

  it('does not flag a call the resolver accepts', () => {
    expect(run('o<found> call\n', () => true)).toEqual([]);
  });

  it('never flags a dynamic (computed) label', () => {
    expect(run('o[#1] call\n', () => false)).toEqual([]);
  });
});
