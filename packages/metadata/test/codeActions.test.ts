import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { parseHal, parseIni, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, MetadataIndex, buildMachineModel, crossFileDiagnostics, codeActions,
  HalFileInput, MachineModel,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
});

function model(iniText: string, halText: string): { model: MachineModel; halUri: string; iniUri: string } {
  const iniUri = 'file:///m.ini';
  const halUri = 'file:///m.hal';
  const files: HalFileInput[] = [{
    uri: halUri, text: halText, lineIndex: new LineIndex(halText), hal: parseHal(halText), phase: 'pre', order: 0,
  }];
  const m = buildMachineModel({
    iniInput: { uri: iniUri, lineIndex: new LineIndex(iniText), ini: parseIni(iniText) },
    files, index,
  });
  return { model: m, halUri, iniUri };
}

/** Diagnostics for the HAL file. */
function halDiags(m: MachineModel, halUri: string) {
  return crossFileDiagnostics(m, index).get(halUri) ?? [];
}

/** Apply a single-file WorkspaceEdit and return the resulting text. */
function applyTo(edit: NonNullable<ReturnType<typeof codeActions>[number]['edit']>, uri: string, text: string): string {
  const li = new LineIndex(text);
  const edits = edit.changes![uri];
  const sorted = [...edits].sort((a, b) => li.offsetAt(b.range.start) - li.offsetAt(a.range.start));
  let s = text;
  for (const e of sorted) {
    s = s.slice(0, li.offsetAt(e.range.start)) + e.newText + s.slice(li.offsetAt(e.range.end));
  }
  return s;
}

describe('code actions — missing INI key', () => {
  it('offers to add a missing key to an existing section', () => {
    const ini = '[JOINT_0]\nTYPE = LINEAR\nMAX_VELOCITY = 5\n';
    const hal = 'setp stepgen.0.maxaccel [JOINT_0]STEPGEN_MAXACCEL\n';
    const { model: m, halUri, iniUri } = model(ini, hal);
    const diags = halDiags(m, halUri);
    const key = diags.find((d) => d.code === 'hal.iniref.keyMissing');
    expect(key).toBeTruthy();
    const actions = codeActions(m, halUri, [key!], index);
    expect(actions.length).toBe(1);
    expect(actions[0].title).toContain('STEPGEN_MAXACCEL');
    const updated = applyTo(actions[0].edit!, iniUri, ini);
    expect(updated).toContain('STEPGEN_MAXACCEL =');
    // inserted into the JOINT_0 section, after the existing keys
    expect(updated.indexOf('STEPGEN_MAXACCEL')).toBeGreaterThan(updated.indexOf('MAX_VELOCITY'));
    // re-parsing + re-diagnosing clears the error
    const m2 = model(updated, hal).model;
    expect(halDiags(m2, halUri).some((d) => d.code === 'hal.iniref.keyMissing')).toBe(false);
  });
});

describe('code actions — missing INI section', () => {
  it('offers to add a missing section with the key', () => {
    const ini = '[JOINT_0]\nTYPE = LINEAR\n';
    const hal = 'net s [SPININFO]MAX_RPM spindle.0.speed-out\n';
    const { model: m, halUri, iniUri } = model(ini, hal);
    const diags = halDiags(m, halUri);
    const sec = diags.find((d) => d.code === 'hal.iniref.sectionMissing');
    expect(sec).toBeTruthy();
    const actions = codeActions(m, halUri, [sec!], index);
    expect(actions[0].title).toContain('[SPININFO]');
    const updated = applyTo(actions[0].edit!, iniUri, ini);
    expect(updated).toContain('[SPININFO]');
    expect(updated).toContain('MAX_RPM =');
    const m2 = model(updated, hal).model;
    expect(halDiags(m2, halUri).some((d) => d.code.startsWith('hal.iniref'))).toBe(false);
  });
});

describe('code actions — did you mean (unknown component)', () => {
  it('suggests the nearest known component name', () => {
    const ini = '[EMC]\nMACHINE = x\n';
    const hal = 'loadrt stepgne count=1\n'; // typo of stepgen
    const { model: m, halUri } = model(ini, hal);
    const diags = halDiags(m, halUri);
    const unknown = diags.find((d) => d.code === 'hal.comp.unknownComponent');
    expect(unknown).toBeTruthy();
    const actions = codeActions(m, halUri, [unknown!], index);
    expect(actions.some((a) => a.title === "Change to 'stepgen'")).toBe(true);
    const fix = actions.find((a) => a.title === "Change to 'stepgen'")!;
    const updated = applyTo(fix.edit!, halUri, hal);
    expect(updated).toContain('loadrt stepgen count=1');
  });
});
