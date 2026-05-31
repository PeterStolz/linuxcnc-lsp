import { describe, it, expect } from 'vitest';
import { parseHal } from '../src/hal/parser';
import { parseIni } from '../src/ini/parser';
import { LineIndex } from '../src/common/lineIndex';
import {
  buildHalSemanticTokens, buildIniSemanticTokens, SEMANTIC_TOKEN_TYPES,
} from '../src/providers/semanticTokens';
import { halDocumentSymbols, iniDocumentSymbols } from '../src/providers/documentSymbol';
import { halFoldingRanges, iniFoldingRanges } from '../src/providers/folding';

const typeName = (i: number) => SEMANTIC_TOKEN_TYPES[i];

describe('HAL semantic tokens', () => {
  it('classifies command, signal, pins and INI ref', () => {
    const text = 'setp pid.x.Pgain [JOINT_0]P';
    const li = new LineIndex(text);
    const toks = buildHalSemanticTokens(parseHal(text), li);
    const byText = (start: number) => toks.find((t) => t.char === start);
    // 'setp' keyword at char 0
    expect(typeName(byText(0)!.type)).toBe('keyword');
    // pid.x.Pgain property at char 5
    expect(typeName(byText(5)!.type)).toBe('property');
    // [JOINT_0]P -> namespace (JOINT_0) + enumMember (P)
    const names = toks.map((t) => typeName(t.type));
    expect(names).toContain('namespace');
    expect(names).toContain('enumMember');
  });

  it('tokens are sorted by position', () => {
    const text = 'net Xpos joint.0.motor-pos-cmd => pid.0.command';
    const li = new LineIndex(text);
    const toks = buildHalSemanticTokens(parseHal(text), li);
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i - 1], b = toks[i];
      expect(a.line < b.line || (a.line === b.line && a.char <= b.char)).toBe(true);
    }
  });
});

describe('INI semantic tokens', () => {
  it('classifies section, key, number and boolean', () => {
    const text = '[JOINT_0]\nMAX_VELOCITY = 5\nHOME_USE_INDEX = YES';
    const li = new LineIndex(text);
    const toks = buildIniSemanticTokens(parseIni(text), li);
    const names = toks.map((t) => SEMANTIC_TOKEN_TYPES[t.type]);
    expect(names).toContain('namespace');
    expect(names).toContain('enumMember');
    expect(names).toContain('number');
    expect(names).toContain('keyword'); // YES boolean
  });
});

describe('document symbols', () => {
  it('lists components, signals and threads for HAL', () => {
    const text = [
      'loadrt and2 count=2',
      'addf and2.0 servo-thread',
      'net flood and2.0.in0',
    ].join('\n');
    const li = new LineIndex(text);
    const syms = halDocumentSymbols(parseHal(text), li);
    const names = syms.map((s) => s.name);
    expect(names).toContain('and2');
    expect(names).toContain('flood');
    expect(names).toContain('servo-thread');
    const and2 = syms.find((s) => s.name === 'and2')!;
    expect(and2.children?.map((c) => c.name)).toEqual(['and2.0', 'and2.1']);
  });

  it('lists sections and keys for INI', () => {
    const text = '[EMC]\nMACHINE = x\n[HAL]\nHALFILE = a.hal';
    const li = new LineIndex(text);
    const syms = iniDocumentSymbols(parseIni(text), li);
    expect(syms.map((s) => s.name)).toEqual(['EMC', 'HAL']);
    expect(syms[0].children?.[0].name).toBe('MACHINE');
  });
});

describe('folding ranges', () => {
  it('folds INI sections', () => {
    const text = '[EMC]\nA = 1\nB = 2\n[HAL]\nC = 3';
    const li = new LineIndex(text);
    const folds = iniFoldingRanges(parseIni(text), li);
    expect(folds.length).toBeGreaterThanOrEqual(1);
    expect(folds[0].startLine).toBe(0);
  });

  it('folds HAL comment blocks', () => {
    const text = '# line 1\n# line 2\n# line 3\nsetp x 1';
    const li = new LineIndex(text);
    const folds = halFoldingRanges(li);
    expect(folds[0]).toMatchObject({ startLine: 0, endLine: 2 });
  });
});
