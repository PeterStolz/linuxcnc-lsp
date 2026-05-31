import { describe, it, expect } from 'vitest';
import {
  parseHal, parseIni, diagnoseHalIntraFile, halDocumentSymbols, LineIndex,
  tokenizeGcode, collectIniRefs, MAX_INSTANCE_COUNT,
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
