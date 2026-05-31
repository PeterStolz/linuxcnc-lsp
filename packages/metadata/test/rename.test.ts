import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { parseHal, parseIni, LineIndex } from '@linuxcnc/core';
import {
  loadDBFromFile, MetadataIndex, buildMachineModel, rename, prepareRename,
  HalFileInput, MachineModel,
} from '../src/index';

const DB = path.resolve(__dirname, '../data/db.json');
let index: MetadataIndex;
beforeAll(() => {
  index = loadDBFromFile(DB);
});

interface FileSpec { uri: string; text: string; }

function model(iniText: string | undefined, files: FileSpec[]): MachineModel {
  const halFiles: HalFileInput[] = files.map((f, i) => ({
    uri: f.uri, text: f.text, lineIndex: new LineIndex(f.text), hal: parseHal(f.text), phase: 'pre', order: i,
  }));
  return buildMachineModel({
    iniInput: iniText !== undefined
      ? { uri: 'file:///m.ini', lineIndex: new LineIndex(iniText), ini: parseIni(iniText) }
      : undefined,
    files: halFiles,
    index,
  });
}

/** Offset of the (n-th) occurrence of `needle` in text, at its midpoint. */
function at(text: string, needle: string, nth = 0): number {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = text.indexOf(needle, idx + 1);
  return idx + Math.floor(needle.length / 2);
}

/** Apply a WorkspaceEdit to the given file texts and return the results. */
function apply(edit: ReturnType<typeof rename>, texts: Record<string, string>): Record<string, string> {
  const out = { ...texts };
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    const li = new LineIndex(out[uri]);
    // apply right-to-left so offsets stay valid
    const sorted = [...edits].sort((a, b) => li.offsetAt(b.range.start) - li.offsetAt(a.range.start));
    let s = out[uri];
    for (const e of sorted) {
      const start = li.offsetAt(e.range.start);
      const end = li.offsetAt(e.range.end);
      s = s.slice(0, start) + e.newText + s.slice(end);
    }
    out[uri] = s;
  }
  return out;
}

describe('rename — HAL signals', () => {
  it('renames every occurrence of a signal across files', () => {
    const a = 'net x-pos-cmd pid.0.output stepgen.0.position-cmd\n';
    const b = 'net x-pos-cmd => foo.in\n';
    const m = model(undefined, [{ uri: 'a.hal', text: a }, { uri: 'b.hal', text: b }]);
    const edit = rename(m, 'a.hal', at(a, 'x-pos-cmd'), 'x-cmd');
    const res = apply(edit, { 'a.hal': a, 'b.hal': b });
    expect(res['a.hal']).toContain('net x-cmd ');
    expect(res['b.hal']).toContain('net x-cmd ');
    expect(res['a.hal']).not.toContain('x-pos-cmd');
    expect(res['b.hal']).not.toContain('x-pos-cmd');
  });

  it('prepareRename reports the signal token + placeholder', () => {
    const a = 'net my-sig and2.0.in0\n';
    const m = model(undefined, [{ uri: 'a.hal', text: a }]);
    const pr = prepareRename(m, 'a.hal', at(a, 'my-sig'));
    expect(pr?.placeholder).toBe('my-sig');
  });

  it('refuses to rename a metadata-defined pin', () => {
    const a = 'loadrt and2 count=1\nsetp and2.0.in0 1\n';
    const m = model(undefined, [{ uri: 'a.hal', text: a }]);
    expect(prepareRename(m, 'a.hal', at(a, 'and2.0.in0'))).toBeNull();
    expect(rename(m, 'a.hal', at(a, 'and2.0.in0'), 'whatever')).toBeNull();
  });
});

describe('rename — INI keys', () => {
  const ini = '[JOINT_0]\nSTEPGEN_MAXACCEL = 21.0\n';
  const hal = 'setp stepgen.0.maxaccel [JOINT_0]STEPGEN_MAXACCEL\nsetp stepgen.0.maxvel [JOINT_0]STEPGEN_MAXACCEL\n';

  it('renames the INI entry and every HAL reference (from the HAL ref)', () => {
    const m = model(ini, [{ uri: 'a.hal', text: hal }]);
    const edit = rename(m, 'a.hal', at(hal, 'STEPGEN_MAXACCEL'), 'SG_MAXACCEL');
    const res = apply(edit, { 'file:///m.ini': ini, 'a.hal': hal });
    expect(res['file:///m.ini']).toContain('SG_MAXACCEL = 21.0');
    expect(res['a.hal'].match(/\[JOINT_0\]SG_MAXACCEL/g)?.length).toBe(2);
    expect(res['a.hal']).not.toContain('STEPGEN_MAXACCEL');
    // the pin name is left untouched
    expect(res['a.hal']).toContain('stepgen.0.maxaccel');
  });

  it('renames from the INI side too', () => {
    const m = model(ini, [{ uri: 'a.hal', text: hal }]);
    const edit = rename(m, 'file:///m.ini', at(ini, 'STEPGEN_MAXACCEL'), 'SG_MAXACCEL');
    const res = apply(edit, { 'file:///m.ini': ini, 'a.hal': hal });
    expect(res['file:///m.ini']).toContain('SG_MAXACCEL');
    expect(res['a.hal']).not.toContain('STEPGEN_MAXACCEL');
  });
});
