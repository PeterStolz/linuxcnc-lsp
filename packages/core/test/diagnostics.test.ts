import { describe, it, expect } from 'vitest';
import { parseHal } from '../src/hal/parser';
import { parseIni } from '../src/ini/parser';
import { LineIndex } from '../src/common/lineIndex';
import { diagnoseHalIntraFile } from '../src/diagnostics/hal';
import { diagnoseIniIntraFile } from '../src/diagnostics/ini';
import { DiagnosticSeverity } from 'vscode-languageserver-types';

function halDiags(text: string, overrides?: Record<string, any>) {
  const li = new LineIndex(text);
  return diagnoseHalIntraFile(text, parseHal(text), li, { overrides });
}
function iniDiags(text: string) {
  const li = new LineIndex(text);
  return diagnoseIniIntraFile(text, parseIni(text), li);
}

describe('HAL intra-file diagnostics', () => {
  it('flags an unknown command', () => {
    const d = halDiags('frobnicate x y');
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe('hal.syntax.unknownCommand');
    expect(d[0].severity).toBe(DiagnosticSeverity.Error);
  });

  it('flags net without a signal', () => {
    const d = halDiags('net');
    expect(d.some((x) => x.code === 'hal.syntax.malformedStatement')).toBe(true);
  });

  it('flags setp without a value', () => {
    const d = halDiags('setp pid.0.Pgain');
    expect(d.some((x) => x.code === 'hal.syntax.malformedStatement')).toBe(true);
  });

  it('accepts a well-formed file with no diagnostics', () => {
    const text = [
      'loadrt and2 count=2',
      'addf and2.0 servo-thread',
      'net flood iocontrol.0.coolant-flood => and2.0.in0',
      'setp and2.0.in1 1',
    ].join('\n');
    expect(halDiags(text)).toHaveLength(0);
  });

  it('respects per-rule severity overrides', () => {
    const d = halDiags('frobnicate', { 'hal.syntax.unknownCommand': 'warning' });
    expect(d[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('respects off override', () => {
    const d = halDiags('frobnicate', { 'hal.syntax.unknownCommand': 'off' });
    expect(d).toHaveLength(0);
  });

  it('respects an inline disable-line suppression', () => {
    const d = halDiags('frobnicate x  # linuxcnc-lsp-disable-line hal.syntax.unknownCommand');
    expect(d).toHaveLength(0);
  });

  it('respects a disable-next-line suppression', () => {
    const text = '# linuxcnc-lsp-disable-next-line hal.syntax.unknownCommand\nfrobnicate x';
    expect(halDiags(text)).toHaveLength(0);
  });
});

describe('INI intra-file diagnostics', () => {
  it('flags an entry outside a section', () => {
    const d = iniDiags('KEY = 1\n[S]\n');
    expect(d.some((x) => x.code === 'ini.syntax.entryOutsideSection')).toBe(true);
  });

  it('flags a malformed line', () => {
    const d = iniDiags('[S]\ngarbage line here\n');
    expect(d.some((x) => x.code === 'ini.syntax.malformedLine')).toBe(true);
  });

  it('flags a duplicate non-repeatable key', () => {
    const d = iniDiags('[JOINT_0]\nMAX_VELOCITY = 5\nMAX_VELOCITY = 6\n');
    expect(d.some((x) => x.code === 'ini.syntax.duplicateKey')).toBe(true);
  });

  it('flags a same-value duplicate as redundantKey (not duplicateKey)', () => {
    const d = iniDiags('[TRAJ]\nMAX_LINEAR_VELOCITY = 5\nMAX_LINEAR_VELOCITY = 5\n');
    expect(d.some((x) => x.code === 'ini.syntax.redundantKey')).toBe(true);
    expect(d.some((x) => x.code === 'ini.syntax.duplicateKey')).toBe(false);
  });

  it('does NOT flag repeated HALFILE keys (repeatable, any value)', () => {
    const d = iniDiags('[HAL]\nHALFILE = a.hal\nHALFILE = b.hal\nHALFILE = a.hal\n');
    const dup = d.some((x) => x.code === 'ini.syntax.duplicateKey' || x.code === 'ini.syntax.redundantKey');
    expect(dup).toBe(false);
  });

  it('does NOT flag repeated PLUGIN in [EZTROL] (section-scoped exception)', () => {
    const d = iniDiags('[EZTROL]\nPLUGIN = wizard.so\nPLUGIN = webwizard.so\n');
    expect(d.some((x) => x.code === 'ini.syntax.duplicateKey')).toBe(false);
  });

  it('DOES flag a conflicting PLUGIN duplicate outside [EZTROL]', () => {
    const d = iniDiags('[DISPLAY]\nPLUGIN = a.so\nPLUGIN = b.so\n');
    expect(d.some((x) => x.code === 'ini.syntax.duplicateKey')).toBe(true);
  });

  it('clean INI produces no diagnostics', () => {
    const d = iniDiags('[EMC]\nMACHINE = test\n[HAL]\nHALFILE = core.hal\n');
    expect(d).toHaveLength(0);
  });
});
