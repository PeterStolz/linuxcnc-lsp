import {
  CodeAction, CodeActionKind, Diagnostic, Position, TextEdit, WorkspaceEdit,
} from 'vscode-languageserver-types';
import { findSection } from '@linuxcnc/core';
import { MetadataIndex } from '../db';
import { MachineModel, IniFileInput } from './types';
import { locateHal } from './navigation';

/** Quick fixes for the diagnostics overlapping `uri`'s requested range. */
export function codeActions(
  model: MachineModel,
  uri: string,
  diagnostics: Diagnostic[],
  index: MetadataIndex,
): CodeAction[] {
  const file = model.files.find((f) => f.uri === uri);
  if (!file) return [];
  const out: CodeAction[] = [];

  for (const d of diagnostics) {
    const offset = file.lineIndex.offsetAt(d.range.start);
    const loc = locateHal(file.hal, offset);

    if (d.code === 'hal.iniref.keyMissing' && loc?.kind === 'iniref') {
      const target = iniWithSection(model, loc.section);
      if (target) out.push(addKeyAction(target, loc.section, loc.key, d));
    } else if (d.code === 'hal.iniref.sectionMissing' && loc?.kind === 'iniref' && model.ini) {
      out.push(addSectionAction(model.ini, loc.section, loc.key, d));
    } else if (d.code === 'hal.comp.unknownComponent' && loc?.kind === 'component') {
      for (const suggestion of nearestComponents(loc.name, index)) {
        out.push(replaceTokenAction(uri, d.range, suggestion, `Change to '${suggestion}'`, d));
      }
    }
  }
  return out;
}

// --- builders --------------------------------------------------------------

function addKeyAction(ini: IniFileInput, section: string, key: string, d: Diagnostic): CodeAction {
  const sec = findSection(ini.ini, section)!;
  const anchor = sec.entries.length ? sec.entries[sec.entries.length - 1].end : sec.headerEnd;
  const edit = insertLine(ini, anchor, `${key} = `);
  return quickFix(`Add '${key}' to [${section}] in ${baseName(ini.uri)}`, ini.uri, [edit], d);
}

function addSectionAction(ini: IniFileInput, section: string, key: string, d: Diagnostic): CodeAction {
  const text = ini.lineIndex.text;
  const pos = ini.lineIndex.positionAt(text.length);
  const lead = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  const edit = TextEdit.insert(pos, `${lead}\n[${section}]\n${key} = \n`);
  return quickFix(`Add section [${section}] with '${key}' in ${baseName(ini.uri)}`, ini.uri, [edit], d);
}

function replaceTokenAction(uri: string, range: Diagnostic['range'], newText: string, title: string, d: Diagnostic): CodeAction {
  return quickFix(title, uri, [TextEdit.replace(range, newText)], d);
}

function quickFix(title: string, uri: string, edits: TextEdit[], d: Diagnostic): CodeAction {
  const edit: WorkspaceEdit = { changes: { [uri]: edits } };
  return { title, kind: CodeActionKind.QuickFix, diagnostics: [d], edit, isPreferred: true };
}

/** Insert a new line after `anchorOffset`'s line, handling the EOF / no-trailing-newline case. */
function insertLine(ini: IniFileInput, anchorOffset: number, content: string): TextEdit {
  const li = ini.lineIndex;
  const line = li.positionAt(anchorOffset).line;
  const isLast = line >= li.lineCount - 1;
  if (isLast && !li.text.endsWith('\n')) {
    return TextEdit.insert(li.positionAt(li.text.length), `\n${content}`);
  }
  const pos: Position = { line: line + 1, character: 0 };
  return TextEdit.insert(pos, `${content}\n`);
}

// --- helpers ---------------------------------------------------------------

function iniWithSection(model: MachineModel, section: string): IniFileInput | undefined {
  const all = model.ini ? [model.ini, ...model.iniIncludes] : model.iniIncludes;
  return all.find((f) => findSection(f.ini, section));
}

function nearestComponents(name: string, index: MetadataIndex, max = 3): string[] {
  const names = new Set<string>([...index.componentNames(), ...index.raw().knownComponentNames]);
  const budget = Math.max(2, Math.ceil(name.length * 0.34));
  return [...names]
    .map((n) => ({ n, d: levenshtein(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d > 0 && x.d <= budget)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.n);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function baseName(uri: string): string {
  const m = /[^/\\]+$/.exec(uri);
  return m ? m[0] : uri;
}
