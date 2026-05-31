import { Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver-types';
import { collectIniRefs, findSection, findEntries } from '@linuxcnc/core';
import { MachineModel, IniFileInput } from './types';
import { locateHal } from './navigation';

export interface PrepareRenameResult {
  range: Range;
  placeholder: string;
}

/** A symbol the editor is allowed to rename. */
type Renamable =
  | { kind: 'signal'; name: string; range: Range }
  | { kind: 'iniKey'; section: string; key: string; range: Range }
  | null;

const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Identify a renameable symbol at `offset` in file `uri` (HAL or the INI). */
function locateRenamable(model: MachineModel, uri: string, offset: number): Renamable {
  const halFile = model.files.find((f) => f.uri === uri);
  if (halFile) {
    const loc = locateHal(halFile.hal, offset);
    if (!loc) return null;
    if (loc.kind === 'signal') {
      return { kind: 'signal', name: loc.name, range: halFile.lineIndex.rangeAt(loc.token.start, loc.token.end) };
    }
    if (loc.kind === 'iniref') {
      const p = loc.token.ini!;
      return { kind: 'iniKey', section: p.section, key: p.key, range: halFile.lineIndex.rangeAt(p.keyStart, p.keyEnd) };
    }
    // pin / component names are metadata-defined — not renameable.
    return null;
  }
  // INI document: a key entry under the cursor.
  for (const ini of iniInputs(model)) {
    if (ini.uri !== uri) continue;
    for (const section of ini.ini.sections) {
      if (offset < section.start || offset > section.end) continue;
      for (const entry of section.entries) {
        if (offset >= entry.key.start && offset <= entry.key.end) {
          return {
            kind: 'iniKey',
            section: section.name.text,
            key: entry.key.text,
            range: ini.lineIndex.rangeAt(entry.key.start, entry.key.end),
          };
        }
      }
    }
  }
  return null;
}

export function prepareRename(model: MachineModel, uri: string, offset: number): PrepareRenameResult | null {
  const r = locateRenamable(model, uri, offset);
  if (!r) return null;
  return { range: r.range, placeholder: r.kind === 'signal' ? r.name : r.key };
}

/** Build a workspace edit renaming the symbol at `offset` to `newName`. */
/** An INI key must match the parser's key grammar; a HAL signal must be a single
 *  bare token (no whitespace or HAL-significant punctuation) — otherwise the edit
 *  would corrupt the file. */
function isValidRenameTarget(kind: 'signal' | 'iniKey', newName: string): boolean {
  if (kind === 'iniKey') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName);
  return newName.length > 0 && !/[\s\[\]()=<>#;"'\\]/.test(newName);
}

export function rename(model: MachineModel, uri: string, offset: number, newName: string): WorkspaceEdit | null {
  const r = locateRenamable(model, uri, offset);
  if (!r || !newName || !isValidRenameTarget(r.kind, newName)) return null;

  const changes: Record<string, TextEdit[]> = {};
  const add = (u: string, range: Range): void => {
    (changes[u] ??= []).push(TextEdit.replace(range, newName));
  };

  if (r.kind === 'signal') {
    const node = model.signals.get(r.name);
    if (!node) return null;
    for (const occ of node.occurrences) add(occ.uri, occ.range);
    return Object.keys(changes).length ? { changes } : null;
  }

  // INI key: rename the entry in the INI (+ includes) and every HAL [SEC]KEY ref.
  for (const ini of iniInputs(model)) {
    const sec = findSection(ini.ini, r.section);
    if (!sec) continue;
    for (const e of findEntries(sec, r.key)) {
      add(ini.uri, ini.lineIndex.rangeAt(e.key.start, e.key.end));
    }
  }
  for (const f of model.files) {
    for (const stmt of f.hal.statements) {
      for (const ref of collectIniRefs(stmt)) {
        const p = ref.ini!;
        if (eqi(p.section, r.section) && eqi(p.key, r.key)) {
          add(f.uri, f.lineIndex.rangeAt(p.keyStart, p.keyEnd));
        }
      }
    }
  }
  return Object.keys(changes).length ? { changes } : null;
}

function iniInputs(model: MachineModel): IniFileInput[] {
  const out: IniFileInput[] = [];
  if (model.ini) out.push(model.ini);
  out.push(...model.iniIncludes);
  return out;
}
