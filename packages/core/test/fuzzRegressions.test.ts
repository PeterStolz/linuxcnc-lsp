import { describe, it, expect } from 'vitest';
import {
  parseHal, parseIni, diagnoseHalIntraFile, diagnoseIniIntraFile, halDocumentSymbols, iniDocumentSymbols, LineIndex,
  tokenizeGcode, GcodeTokenKind, collectIniRefs, MAX_INSTANCE_COUNT,
} from '../src/index';

// Regression tests for bugs found by the fuzz/persona sweep (core surfaces).

describe('unbounded loadrt count= (fuzz #1/#2/#3)', () => {
  it('clamps an absurd count at parse time', () => {
    const s = parseHal('loadrt pid count=99999999999').statements[0] as { count?: number };
    expect(s.count).toBe(MAX_INSTANCE_COUNT);
  });

  it('halDocumentSymbols neither throws nor materializes a huge array', () => {
    const text = 'loadrt pid count=999999999999999999999';
    let syms: ReturnType<typeof halDocumentSymbols> = [];
    expect(() => { syms = halDocumentSymbols(parseHal(text), new LineIndex(text)); }).not.toThrow();
    const loadrt = syms[0];
    expect((loadrt.children?.length ?? 0)).toBeLessThanOrEqual(256);
    // the true count is still reported in the detail
    expect(loadrt.detail).toContain('instance');
  });
});

describe('collectIniRefs dedupe (fuzz #8)', () => {
  it('returns a loadrt config= INI ref exactly once', () => {
    const stmt = parseHal('loadrt hm2_eth config=[HOSTMOT2](BOARD)').statements[0];
    const refs = collectIniRefs(stmt);
    expect(refs.length).toBe(1);
    expect(refs[0].ini?.section).toBe('HOSTMOT2');
  });
});

describe('error-line severity (fuzz #31)', () => {
  const diag = (t: string) => diagnoseHalIntraFile(t, parseHal(t), new LineIndex(t));
  it('a word that is not a command is a hard unknownCommand Error', () => {
    const d = diag('loart pid count=1');
    expect(d.some((x) => x.code === 'hal.syntax.unknownCommand')).toBe(true);
  });
  it('a junk line not starting with a word is only a Hint (wrapped-comment artifact)', () => {
    const d = diag('#loadrt foo config="a\n(STEPGENS)"sserial_port_0=[X](Y)');
    expect(d.some((x) => x.code === 'hal.syntax.unknownCommand')).toBe(false);
    expect(d.some((x) => x.code === 'hal.syntax.unrecognizedLine')).toBe(true);
  });
});

describe('BOM + bare CR robustness (fuzz #15/#30)', () => {
  it('a leading UTF-8 BOM does not make the first command unknown', () => {
    const text = '﻿loadrt pid count=1';
    const d = diagnoseHalIntraFile(text, parseHal(text), new LineIndex(text));
    expect(d.some((x) => x.code === 'hal.syntax.unknownCommand')).toBe(false);
  });

  it('LineIndex treats a bare CR as a line break', () => {
    const li = new LineIndex('a\rb\rc');
    expect(li.lineCount).toBe(3);
    expect(li.positionAt(2).line).toBe(1); // 'b'
  });

  it('parseIni handles CR-only line endings (no malformedLine, sections found)', () => {
    const ini = parseIni('[EMC]\rMACHINE = x\r[TRAJ]\rLINEAR_UNITS = mm');
    expect(ini.sections.map((s) => s.name.text)).toEqual(['EMC', 'TRAJ']);
    expect(ini.problems.some((p) => p.code === 'ini.syntax.malformedLine')).toBe(false);
  });
});

describe('G-code exponent codes (fuzz #19)', () => {
  it('does not fold an exponent value into a canonical G/M code', () => {
    const t = tokenizeGcode('G1e9 M3e0 G0e5');
    const codes = t.filter((x) => x.letter && (x.letter === 'G' || x.letter === 'M')).map((x) => x.code);
    expect(codes.every((c) => c === undefined)).toBe(true); // none normalized to G1/M3/G0
    expect(tokenizeGcode('G1')[0].code).toBe('G1'); // plain still works
  });
});

describe('G-code code normalization + names= clamp (round2 #9/#12)', () => {
  it('normalizeNum never emits exponent notation for huge G/M code numbers', () => {
    const t = tokenizeGcode('G999999999999999999999999');
    // value kept verbatim; no exponent, no digit alteration
    expect(t[0].code === undefined || !/e/i.test(t[0].code!)).toBe(true);
    expect(tokenizeGcode('G01')[0].code).toBe('G1');
    expect(tokenizeGcode('G38.20')[0].code).toBe('G38.2');
  });
  it('names= is clamped to MAX_INSTANCE_COUNT', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `n${i}`).join(',');
    const s = parseHal(`loadrt pid names=${names}`).statements[0] as { names?: string[] };
    expect(s.names!.length).toBe(MAX_INSTANCE_COUNT);
  });
});

describe('bare-CR comment/param scanners (round2 #8)', () => {
  it('a HAL # comment with CR endings does not swallow the next line', () => {
    const text = 'loadrt and2\r# a comment\rnet s and2.0.out\r';
    const d = diagnoseHalIntraFile(text, parseHal(text), new LineIndex(text));
    // the `net` line must be parsed, not eaten by the comment
    expect(d.some((x) => x.code === 'hal.syntax.unknownCommand')).toBe(false);
    expect(parseHal(text).statements.some((s) => s.kind === 'net')).toBe(true);
  });
  it('a G-code ( comment with CR endings stops at the CR', () => {
    const t = tokenizeGcode('G0 (rapid)\rG1 X1\r');
    expect(t.some((x) => x.code === 'G1')).toBe(true); // G1 not swallowed by the comment
  });
});

describe('round-3 edge fixes (core)', () => {
  it('tokenizes indirect/computed O-word names (o[expr], o#param)', () => {
    const a = tokenizeGcode('o[#1] call');
    expect(a[0].kind).toBe(GcodeTokenKind.Oword);
    expect(a.some((t) => t.kind === GcodeTokenKind.OKeyword && t.text === 'call')).toBe(true);
    const b = tokenizeGcode('o#5 endsub');
    expect(b[0].kind).toBe(GcodeTokenKind.Oword);
    expect(b.some((t) => t.kind === GcodeTokenKind.OKeyword)).toBe(true);
  });

  it('iniDocumentSymbols keeps child ranges within the parent (no trailing newline)', () => {
    const text = '[EMC]\nMACHINE = x';
    const li = new LineIndex(text);
    const sec = iniDocumentSymbols(parseIni(text), li)[0];
    const child = sec.children![0];
    const within = li.offsetAt(child.range.start) >= li.offsetAt(sec.range.start)
      && li.offsetAt(child.range.end) <= li.offsetAt(sec.range.end);
    expect(within).toBe(true);
  });

  it('a configobj [[ in a continuation value does not suppress INI diagnostics', () => {
    const text = '[EMC]\nKEY = a \\\n[[notasection]]\nbadline no equals\n';
    const d = diagnoseIniIntraFile(text, parseIni(text), new LineIndex(text));
    expect(d.some((x) => x.code === 'ini.syntax.malformedLine')).toBe(true);
  });

  it('a real configobj nested section still suppresses diagnostics', () => {
    const text = '[WIDGET]\nx = 1\n[[child]]\ny = 2\n';
    const d = diagnoseIniIntraFile(text, parseIni(text), new LineIndex(text));
    expect(d).toEqual([]);
  });
});

describe('instance-count keywords (audit #1/#4/#9)', () => {
  const count = (t: string) => (parseHal(t).statements[0] as { count?: number }).count;
  it('num_chan= sets the instance count (pid/encoder)', () => expect(count('loadrt pid num_chan=3')).toBe(3));
  it('step_type= array length sets the count (stepgen)', () => expect(count('loadrt stepgen step_type=0,0,0')).toBe(3));
  it('ctrl_type= array length too', () => expect(count('loadrt stepgen ctrl_type=v,p')).toBe(2));
  it('output_type= array length (pwmgen)', () => expect(count('loadrt pwmgen output_type=1,1,2')).toBe(3));
  it('explicit count= still works and is preferred', () => expect(count('loadrt pid count=5')).toBe(5));
  it('no count keyword -> undefined (singleton)', () => expect(count('loadrt and2')).toBeUndefined());
});

describe('INI value continuation (fuzz #17/#18)', () => {
  it('keeps a continued value span inside the document', () => {
    const text = '[X]\nKEY = a \\\n  b \\\n  c\n';
    const ini = parseIni(text);
    const v = ini.sections[0].entries[0].value!;
    expect(v.start).toBeGreaterThanOrEqual(0);
    expect(v.end).toBeLessThanOrEqual(text.length);
    expect(v.start).toBeLessThan(v.end);
  });

  it('parses a value with thousands of continuation lines quickly (no O(n^2))', () => {
    const big = '[X]\nKEY = ' + Array.from({ length: 8000 }, () => 'x \\').join('\n') + '\nend\n';
    const t0 = performance.now();
    parseIni(big);
    expect(performance.now() - t0).toBeLessThan(800);
  });
});
