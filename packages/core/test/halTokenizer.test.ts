import { describe, it, expect } from 'vitest';
import { tokenizeHal } from '../src/hal/tokenizer';
import { HalTokenKind } from '../src/hal/tokens';

const kinds = (text: string, lineIdx = 0) =>
  tokenizeHal(text)[lineIdx].tokens.map((t) => `${t.kind}:${t.text}`);

describe('HAL tokenizer', () => {
  it('tokenizes a net statement with an arrow', () => {
    expect(kinds('net Xpos joint.0.motor-pos-cmd => pid.0.command')).toEqual([
      'word:net',
      'word:Xpos',
      'word:joint.0.motor-pos-cmd',
      'arrow:=>',
      'word:pid.0.command',
    ]);
  });

  it('tokenizes <= arrow', () => {
    expect(kinds('net Xacc <= ddt_xv.out')).toEqual([
      'word:net',
      'word:Xacc',
      'arrow:<=',
      'word:ddt_xv.out',
    ]);
  });

  it('parses an INI reference into section and key', () => {
    const line = tokenizeHal('setp pid.x.Pgain [JOINT_0]P')[0];
    const ref = line.tokens[2];
    expect(ref.kind).toBe(HalTokenKind.IniRef);
    expect(ref.ini).toMatchObject({ section: 'JOINT_0', key: 'P' });
    // sub-ranges point at the right substrings
    expect(line.tokens[2].text.slice(
      ref.ini!.sectionStart - ref.start,
      ref.ini!.sectionEnd - ref.start,
    )).toBe('JOINT_0');
    expect(line.tokens[2].text.slice(
      ref.ini!.keyStart - ref.start,
      ref.ini!.keyEnd - ref.start,
    )).toBe('P');
  });

  it('parses a parenthesized INI reference', () => {
    const line = tokenizeHal('loadrt foo p=[MODBUS](PORTS)')[0];
    const ref = line.tokens.find((t) => t.kind === HalTokenKind.IniRef);
    expect(ref?.ini).toMatchObject({ section: 'MODBUS', key: 'PORTS' });
  });

  it('handles key=value modparams and INI-ref values', () => {
    expect(kinds('loadrt [EMCMOT]EMCMOT base_period_nsec=[EMCMOT]BASE_PERIOD')).toEqual([
      'word:loadrt',
      'iniref:[EMCMOT]EMCMOT',
      'word:base_period_nsec',
      'equals:=',
      'iniref:[EMCMOT]BASE_PERIOD',
    ]);
  });

  it('keeps names=a,b,c as a single value word', () => {
    expect(kinds('loadrt pid names=pid.x,pid.x2,pid.y')).toEqual([
      'word:loadrt',
      'word:pid',
      'word:names',
      'equals:=',
      'word:pid.x,pid.x2,pid.y',
    ]);
  });

  it('captures a double-quoted config string as one token', () => {
    const t = kinds('loadrt hm2_eth config="num_stepgens=4 sserial_port_0=1"');
    expect(t).toContain('string:"num_stepgens=4 sserial_port_0=1"');
  });

  it('recognizes number bases', () => {
    expect(kinds('setp x 0x1F4')[2]).toBe('number:0x1F4');
    expect(kinds('setp x 0b1010')[2]).toBe('number:0b1010');
    expect(kinds('setp x -50')[2]).toBe('number:-50');
    expect(kinds('setp x 3.14e-2')[2]).toBe('number:3.14e-2');
    expect(kinds('setp x 45000')[2]).toBe('number:45000');
  });

  it('captures trailing comments separately from tokens', () => {
    const line = tokenizeHal('setp pid.0.Pgain 0.5  # inline comment')[0];
    expect(line.tokens.map((t) => t.text)).toEqual(['setp', 'pid.0.Pgain', '0.5']);
    expect(line.comment?.text).toBe('# inline comment');
  });

  it('joins backslash line continuations into one logical line', () => {
    const text = 'loadrt motmod \\\n  base=1 \\\n  servo=2';
    const lines = tokenizeHal(text);
    expect(lines.length).toBe(1);
    expect(lines[0].tokens.map((t) => t.text)).toEqual([
      'loadrt', 'motmod', 'base', '=', '1', 'servo', '=', '2',
    ]);
  });

  it('tokenizes environment variables', () => {
    const t = kinds('loadusr -W $(HOME)/bin/app $FOO');
    expect(t).toContain('envvar:$(HOME)');
    expect(t).toContain('envvar:$FOO');
  });

  it('produces no logical line for blank/whitespace-only input', () => {
    expect(tokenizeHal('\n\n   \n')).toEqual([]);
  });

  it('makes forward progress on stray boundary characters (no infinite loop)', () => {
    // A stray '(' and a non-iniref '[' must not hang the tokenizer.
    const lines = tokenizeHal('setp x (  )\nnet a [ b');
    expect(lines.length).toBe(2);
    expect(lines[0].tokens.some((t) => t.text === '(')).toBe(true);
    expect(lines[1].tokens.some((t) => t.text === '[')).toBe(true);
  });

  it('tokenizes every printable ASCII char without hanging', () => {
    let s = '';
    for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
    expect(() => tokenizeHal(s + '\n' + s)).not.toThrow();
  });
});
