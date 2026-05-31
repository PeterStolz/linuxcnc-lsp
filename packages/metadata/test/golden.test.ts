import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { parseHal, parseIni, findSection, findEntries, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, MetadataIndex, buildMachineModel, crossFileDiagnostics,
  compToComponentDef, parseCompFile, definition, HalFileInput, IniFileInput, MachineModel,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
const FLEXI = path.resolve(__dirname, '../../../fixtures/flexicam');

let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
  // Load flexicam's custom .comp into the overlay (as the server does).
  const overlay = fs
    .readdirSync(FLEXI)
    .filter((f) => f.endsWith('.comp'))
    .map((f) => parseCompFile(fs.readFileSync(path.join(FLEXI, f), 'utf8')))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map(compToComponentDef);
  index.setOverlay(overlay);
});

/** Build a machine model for an INI in a fixture dir (resolves HALFILE list). */
function buildFromIni(dir: string, iniName: string): MachineModel {
  const iniPath = path.join(dir, iniName);
  const iniText = fs.readFileSync(iniPath, 'utf8');
  const ini = parseIni(iniText);
  const hal = findSection(ini, 'HAL');
  const files: HalFileInput[] = [];
  let order = 0;
  const add = (value: string, phase: 'pre' | 'postgui') => {
    const v = value.trim().split(/\s+/)[0];
    if (!v || v.startsWith('LIB:') || v.endsWith('.tcl')) return;
    const p = path.join(dir, v);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    files.push({ uri: `file://${p}`, text, lineIndex: new LineIndex(text), hal: parseHal(text), phase, order: order++ });
  };
  if (hal) {
    for (const e of findEntries(hal, 'HALFILE')) if (e.value) add(e.value.text, 'pre');
    for (const e of findEntries(hal, 'POSTGUI_HALFILE')) if (e.value) add(e.value.text, 'postgui');
  }
  const iniInput: IniFileInput = { uri: `file://${iniPath}`, lineIndex: new LineIndex(iniText), ini };
  return buildMachineModel({ iniInput, files, index });
}

describe('flexicam golden config (acceptance)', () => {
  let model: MachineModel;
  beforeAll(() => {
    model = buildFromIni(FLEXI, 'Flexicam.ini');
  });

  it('builds a multi-file model with named instances and cross-file signals', () => {
    expect(model.files.length).toBeGreaterThanOrEqual(2);
    expect(model.instances.get('pid.x')?.comp).toBe('pid');
    expect(model.instances.get('pid.x2')?.comp).toBe('pid');
    // a signal wired across Flexicam.hal and custom_postgui.hal
    expect(model.signals.has('x-pos-cmd')).toBe(true);
  });

  it('produces ZERO error/warning diagnostics on the known-good config', () => {
    const diags = crossFileDiagnostics(model, index);
    const bad: string[] = [];
    for (const list of diags.values()) {
      for (const d of list) {
        if (d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning) {
          bad.push(`${d.code}: ${d.message}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('go-to-definition resolves a cross-file signal', () => {
    // Find a file that uses x-pos-cmd and locate an occurrence offset.
    for (const f of model.files) {
      const idx = f.text.indexOf('x-pos-cmd');
      if (idx < 0) continue;
      const defs = definition(model, f.uri, idx + 2);
      expect(defs.length).toBeGreaterThanOrEqual(1);
      return;
    }
    throw new Error('x-pos-cmd not found in any file');
  });
});

describe('broken config (positive diagnostics)', () => {
  it('flags a missing INI section and key from HAL', () => {
    const iniText = '[KINS]\nJOINTS = 1\n[JOINT_0]\nP = 1\n';
    const halText = 'loadrt pid names=pid.0\nsetp pid.0.Pgain [JOINT_0]P\nsetp pid.0.Igain [JOINT_0]NONEXISTENT_KEY\nnet s [NOPE]VAL pid.0.command\n';
    const ini = parseIni(iniText);
    const model = buildMachineModel({
      iniInput: { uri: 'file:///b.ini', lineIndex: new LineIndex(iniText), ini },
      files: [{ uri: 'file:///b.hal', text: halText, lineIndex: new LineIndex(halText), hal: parseHal(halText), phase: 'pre', order: 0 }],
      index,
    });
    const diags = crossFileDiagnostics(model, index).get('file:///b.hal') ?? [];
    expect(diags.some((d) => d.code === 'hal.iniref.keyMissing' && d.message.includes('NONEXISTENT_KEY'))).toBe(true);
    expect(diags.some((d) => d.code === 'hal.iniref.sectionMissing' && d.message.includes('NOPE'))).toBe(true);
    // [JOINT_0]P is present -> not flagged
    expect(diags.some((d) => d.message.includes('[JOINT_0]P '))).toBe(false);
  });
});
