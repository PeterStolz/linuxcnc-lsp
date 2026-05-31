import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tokenizeLine, hasScope } from './tmgrammar';

const GRAMMAR_DIR = path.resolve(__dirname, '../../client/grammars');
const GRAMMARS = ['hal.tmLanguage.json', 'ini.tmLanguage.json', 'gcode.tmLanguage.json'];

describe('TextMate grammar files are well-formed', () => {
  for (const file of GRAMMARS) {
    const grammar = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, file), 'utf8'));
    it(`${file} has scopeName, name and patterns`, () => {
      expect(typeof grammar.scopeName).toBe('string');
      expect(grammar.scopeName.length).toBeGreaterThan(0);
      expect(Array.isArray(grammar.patterns)).toBe(true);
      expect(grammar.patterns.length).toBeGreaterThan(0);
    });
    it(`${file} #include refs resolve`, () => {
      const repoKeys = new Set(Object.keys(grammar.repository ?? {}));
      const includes: string[] = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
          for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
            if (k === 'include' && typeof v === 'string') includes.push(v);
            else walk(v);
          }
        }
      };
      walk(grammar);
      for (const inc of includes) {
        if (inc.startsWith('#')) expect(repoKeys.has(inc.slice(1)), inc).toBe(true);
      }
    });
  }
});

describe('HAL grammar tokenization', () => {
  it('highlights a net statement: command, signal, pins, operator', async () => {
    const t = await tokenizeLine('source.hal', 'net Xpos joint.0.motor-pos-cmd => pid.0.command');
    expect(hasScope(t, 'net', 'keyword.control.command.hal')).toBe(true);
    expect(hasScope(t, 'joint.0.motor-pos-cmd', 'variable.other.pin.hal')).toBe(true);
    expect(hasScope(t, 'pid.0.command', 'variable.other.pin.hal')).toBe(true);
    expect(hasScope(t, '=>', 'keyword.operator.assignment.hal')).toBe(true);
  });

  it('highlights INI references in setp', async () => {
    const t = await tokenizeLine('source.hal', 'setp pid.x.Pgain [JOINT_0]P');
    expect(hasScope(t, 'setp', 'keyword.control.command.hal')).toBe(true);
    expect(hasScope(t, 'JOINT_0', 'entity.name.namespace.section.hal')).toBe(true);
    expect(hasScope(t, 'P', 'variable.other.iniref.key.hal')).toBe(true);
  });

  it('highlights parenthesized INI references', async () => {
    const t = await tokenizeLine('source.hal', 'loadrt foo bar=[MODBUS](PORTS)');
    expect(hasScope(t, 'loadrt', 'keyword.control.command.hal')).toBe(true);
    expect(hasScope(t, 'MODBUS', 'entity.name.namespace.section.hal')).toBe(true);
    expect(hasScope(t, 'PORTS', 'variable.other.iniref.key.hal')).toBe(true);
  });

  it('highlights comments and numbers', async () => {
    const t = await tokenizeLine('source.hal', 'setp stepgen.0.steplen 0x1F4  # comment');
    expect(hasScope(t, '0x1F4', 'constant.numeric.hex.hal')).toBe(true);
    expect(t.some((x) => x.scopes.some((s) => s.includes('comment.line')))).toBe(true);
  });

  it('highlights environment variables', async () => {
    const t = await tokenizeLine('source.hal', 'loadusr -W $(HOME)/bin/thing');
    expect(t.some((x) => x.scopes.some((s) => s.includes('variable.parameter.env.hal')))).toBe(true);
  });
});

describe('INI grammar tokenization', () => {
  it('highlights section headers', async () => {
    const t = await tokenizeLine('source.linuxcnc-ini', '[JOINT_0]');
    expect(hasScope(t, 'JOINT_0', 'entity.name.section.ini')).toBe(true);
  });

  it('highlights key = value', async () => {
    const t = await tokenizeLine('source.linuxcnc-ini', 'HOME_SEARCH_VEL = 20.0');
    expect(hasScope(t, 'HOME_SEARCH_VEL', 'variable.other.key.ini')).toBe(true);
    expect(t.some((x) => x.scopes.some((s) => s.includes('constant.numeric.float.ini')))).toBe(true);
  });

  it('highlights boolean values', async () => {
    const t = await tokenizeLine('source.linuxcnc-ini', 'HOME_USE_INDEX = YES');
    expect(t.some((x) => x.scopes.some((s) => s.includes('constant.language.boolean.ini')))).toBe(true);
  });

  it('treats a full-line ; or # as a comment', async () => {
    const semi = await tokenizeLine('source.linuxcnc-ini', '  ; a comment');
    expect(semi.some((x) => x.scopes.some((s) => s.includes('comment.line.ini')))).toBe(true);
    const hash = await tokenizeLine('source.linuxcnc-ini', '# DISPLAY = axis');
    expect(hash.some((x) => x.scopes.some((s) => s.includes('comment.line.ini')))).toBe(true);
  });

  it('does NOT treat a trailing # as a comment (it is part of the value)', async () => {
    // Per ini-config.adoc: "INCORRECT = value # and this is not a comment".
    const t = await tokenizeLine('source.linuxcnc-ini', 'INCORRECT = value # not a comment');
    expect(t.some((x) => x.scopes.some((s) => s.includes('comment.line.ini')))).toBe(false);
  });
});

describe('G-code grammar tokenization', () => {
  it('highlights G/M words and parameters', async () => {
    const t = await tokenizeLine('source.gcode', 'G0 X10 Y-5 #<myvar>');
    expect(t.some((x) => x.scopes.some((s) => s.includes('keyword.other.gcode.g')))).toBe(true);
    expect(t.some((x) => x.scopes.some((s) => s.includes('variable.other.named-parameter.gcode')))).toBe(true);
  });

  it('highlights parenthesized comments', async () => {
    const t = await tokenizeLine('source.gcode', 'G1 (this is a comment) X1');
    expect(t.some((x) => x.scopes.some((s) => s.includes('comment.block.gcode')))).toBe(true);
  });
});
