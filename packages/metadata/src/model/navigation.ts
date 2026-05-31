import { Location, DocumentHighlight, DocumentHighlightKind } from 'vscode-languageserver-types';
import {
  HalFile, HalToken, collectIniRefs, findSection, findEntries,
  LoadrtStatement, NetStatement, SetpStatement, SetsStatement, LinkStatement, NewsigStatement,
  UnlinkpStatement, AliasStatement,
} from '@linuxcnc/core';
import { MachineModel, HalFileInput } from './types';

export type Located =
  | { kind: 'signal'; name: string; token: HalToken }
  | { kind: 'pin'; name: string; token: HalToken }
  | { kind: 'iniref'; section: string; key: string; token: HalToken }
  | { kind: 'component'; name: string; token: HalToken }
  | undefined;

const inTok = (t: HalToken | undefined, off: number): t is HalToken => !!t && off >= t.start && off <= t.end;

/** Identify the HAL symbol under `offset`. */
export function locateHal(hal: HalFile, offset: number): Located {
  for (const stmt of hal.statements) {
    if (offset < stmt.start || offset > stmt.end) continue;
    switch (stmt.kind) {
      case 'loadrt': {
        const s = stmt as LoadrtStatement;
        if (inTok(s.componentToken, offset)) {
          return s.componentToken.ini
            ? iniLoc(s.componentToken)
            : { kind: 'component', name: s.componentToken.text, token: s.componentToken };
        }
        for (const mp of s.modparams) if (inTok(mp.valueToken, offset) && mp.valueToken!.ini) return iniLoc(mp.valueToken!);
        break;
      }
      case 'net': {
        const s = stmt as NetStatement;
        if (inTok(s.signalToken, offset)) return { kind: 'signal', name: s.signalToken.text, token: s.signalToken };
        // A pin may embed an INI substitution (hm2_[HOSTMOT2](BOARD).0.gpio.in)
        // which the tokenizer splits into contiguous link tokens. Merge them so
        // a fragment isn't mistaken for a whole pin (which conflates distinct
        // pins sharing the trailing fragment in find-references).
        for (const atom of mergeLinkAtoms(s.links)) {
          for (const t of atom.tokens) {
            if (!inTok(t, offset)) continue;
            if (t.ini) return iniLoc(t);
            return { kind: 'pin', name: atom.tokens.length === 1 ? t.text : atom.text, token: t };
          }
        }
        break;
      }
      case 'linkpp': {
        const s = stmt as LinkStatement;
        if (inTok(s.firstToken, offset)) return { kind: 'pin', name: s.firstToken!.text, token: s.firstToken! };
        if (inTok(s.secondToken, offset)) return { kind: 'pin', name: s.secondToken!.text, token: s.secondToken! };
        break;
      }
      case 'unlinkp': {
        const s = stmt as UnlinkpStatement;
        if (inTok(s.pinToken, offset)) return { kind: 'pin', name: s.pinToken!.text, token: s.pinToken! };
        break;
      }
      case 'alias':
      case 'unalias': {
        const s = stmt as AliasStatement;
        if (inTok(s.originalToken, offset)) return { kind: 'pin', name: s.originalToken!.text, token: s.originalToken! };
        if (inTok(s.aliasToken, offset)) return { kind: 'pin', name: s.aliasToken!.text, token: s.aliasToken! };
        break;
      }
      case 'newsig': {
        const s = stmt as NewsigStatement;
        if (inTok(s.signalToken, offset)) return { kind: 'signal', name: s.signalToken.text, token: s.signalToken };
        break;
      }
      case 'setp': {
        const s = stmt as SetpStatement;
        if (inTok(s.pinToken, offset)) return { kind: 'pin', name: s.pinToken.text, token: s.pinToken };
        if (inTok(s.valueToken, offset) && s.valueToken!.ini) return iniLoc(s.valueToken!);
        break;
      }
      case 'sets': {
        const s = stmt as SetsStatement;
        if (inTok(s.signalToken, offset)) return { kind: 'signal', name: s.signalToken.text, token: s.signalToken };
        if (inTok(s.valueToken, offset) && s.valueToken!.ini) return iniLoc(s.valueToken!);
        break;
      }
      case 'linkps': {
        const s = stmt as LinkStatement;
        if (inTok(s.firstToken, offset)) return { kind: 'pin', name: s.firstToken!.text, token: s.firstToken! };
        if (inTok(s.secondToken, offset)) return { kind: 'signal', name: s.secondToken!.text, token: s.secondToken! };
        break;
      }
      case 'linksp': {
        const s = stmt as LinkStatement;
        if (inTok(s.firstToken, offset)) return { kind: 'signal', name: s.firstToken!.text, token: s.firstToken! };
        if (inTok(s.secondToken, offset)) return { kind: 'pin', name: s.secondToken!.text, token: s.secondToken! };
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

function iniLoc(t: HalToken): Located {
  return { kind: 'iniref', section: t.ini!.section, key: t.ini!.key, token: t };
}

/** Group contiguous (no-whitespace-between) net link tokens into one pin atom,
 *  mirroring build.ts mergePinAtoms, so an embedded INI substitution does not
 *  split a single pin into separate fragments. */
function mergeLinkAtoms(links: NetStatement['links']): Array<{ tokens: HalToken[]; text: string }> {
  const atoms: Array<{ tokens: HalToken[]; text: string }> = [];
  let cur: { tokens: HalToken[]; text: string; lastEnd: number } | undefined;
  for (const l of links) {
    const t = l.pinToken;
    if (cur && t.start === cur.lastEnd) {
      cur.tokens.push(t);
      cur.text += t.text;
      cur.lastEnd = t.end;
    } else {
      if (cur) atoms.push({ tokens: cur.tokens, text: cur.text });
      cur = { tokens: [t], text: t.text, lastEnd: t.end };
    }
  }
  if (cur) atoms.push({ tokens: cur.tokens, text: cur.text });
  return atoms;
}

/** Go-to-definition for the symbol at `offset` in file `uri`. */
export function definition(model: MachineModel, uri: string, offset: number): Location[] {
  const file = model.files.find((f) => f.uri === uri);
  if (!file) return [];
  const loc = locateHal(file.hal, offset);
  if (!loc) return [];

  if (loc.kind === 'signal') {
    const def = model.signals.get(loc.name)?.firstDef;
    return def ? [def] : [];
  }
  if (loc.kind === 'iniref') {
    return iniEntryLocations(model, loc.section, loc.key);
  }
  if (loc.kind === 'pin') {
    // Definition of a pin = the loadrt line that created its instance.
    let best: { name: string; loadLoc: Location } | undefined;
    for (const info of model.instances.values()) {
      if (loc.name === info.name || loc.name.startsWith(info.name + '.')) {
        if (!best || info.name.length > best.name.length) best = info;
      }
    }
    return best ? [best.loadLoc] : [];
  }
  return [];
}

/** Identify the INI key under `offset` in INI file `uri` (the main INI or an
 *  #INCLUDE-d file), or undefined if not on a key. */
function locateIniKey(model: MachineModel, uri: string, offset: number): { section: string; key: string; range: import('vscode-languageserver-types').Range } | undefined {
  for (const ini of [model.ini, ...model.iniIncludes]) {
    if (!ini || ini.uri !== uri) continue;
    for (const section of ini.ini.sections) {
      if (offset < section.start || offset > section.end) continue;
      for (const entry of section.entries) {
        if (offset >= entry.key.start && offset <= entry.key.end) {
          return { section: section.name.text, key: entry.key.text, range: ini.lineIndex.rangeAt(entry.key.start, entry.key.end) };
        }
      }
    }
  }
  return undefined;
}

/** Find references for the symbol at `offset` in file `uri`. */
export function references(model: MachineModel, uri: string, offset: number, includeDecl = true): Location[] {
  const file = model.files.find((f) => f.uri === uri);
  if (!file) {
    // INI document: references of the key under the cursor.
    const iniHit = locateIniKey(model, uri, offset);
    return iniHit ? iniReferences(model, iniHit.section, iniHit.key, includeDecl) : [];
  }
  const loc = locateHal(file.hal, offset);
  if (!loc) return [];

  if (loc.kind === 'signal') {
    const node = model.signals.get(loc.name);
    if (!node) return [];
    const all = [...node.occurrences];
    if (!includeDecl && node.firstDef) {
      return all.filter((l) => !sameLoc(l, node.firstDef!));
    }
    return all;
  }
  if (loc.kind === 'iniref') {
    return iniReferences(model, loc.section, loc.key, includeDecl);
  }
  if (loc.kind === 'pin') {
    return scanPinOccurrences(model.files, loc.name);
  }
  return [];
}

/** All references to an INI key: every HAL `[SEC]KEY` use + (optionally) the
 *  INI entry declaration(s). */
function iniReferences(model: MachineModel, section: string, key: string, includeDecl: boolean): Location[] {
  const out = iniRefsTo(model, section, key);
  if (includeDecl) out.push(...iniEntryLocations(model, section, key));
  return out;
}

/** Same-symbol highlights within a single file. */
export function documentHighlights(model: MachineModel, uri: string, offset: number): DocumentHighlight[] {
  const file = model.files.find((f) => f.uri === uri);
  if (!file) {
    // INI document: highlight every occurrence of the key in this INI file.
    const iniHit = locateIniKey(model, uri, offset);
    if (!iniHit) return [];
    return iniEntryLocations(model, iniHit.section, iniHit.key)
      .filter((l) => l.uri === uri)
      .map((l) => ({ range: l.range, kind: DocumentHighlightKind.Text }));
  }
  const loc = locateHal(file.hal, offset);
  if (!loc) return [];
  if (loc.kind === 'signal') {
    const node = model.signals.get(loc.name);
    if (!node) return [];
    const here = <T extends { uri: string }>(l: T) => l.uri === uri;
    return [
      ...node.occurrences.filter(here).map((l) => ({ range: l.range, kind: DocumentHighlightKind.Text })),
      ...node.writers.filter((w) => here(w.loc)).map((w) => ({ range: w.loc.range, kind: DocumentHighlightKind.Write })),
      ...node.readers.filter((r) => here(r.loc)).map((r) => ({ range: r.loc.range, kind: DocumentHighlightKind.Read })),
    ];
  }
  if (loc.kind === 'pin') {
    return scanPinOccurrences(model.files, loc.name)
      .filter((l) => l.uri === uri)
      .map((l) => ({ range: l.range, kind: DocumentHighlightKind.Text }));
  }
  return [];
}

/** All HAL `[SECTION]KEY` references to a given INI key, across every HAL file
 *  of the machine (case-insensitive). Used for the INI-key "referenced by N"
 *  hover annotation and for find-references. */
export function iniRefsTo(model: MachineModel, section: string, key: string): Location[] {
  const out: Location[] = [];
  for (const f of model.files) {
    for (const stmt of f.hal.statements) {
      for (const ref of collectIniRefs(stmt)) {
        if (eqi(ref.ini!.section, section) && eqi(ref.ini!.key, key)) {
          out.push({ uri: f.uri, range: f.lineIndex.rangeAt(ref.start, ref.end) });
        }
      }
    }
  }
  return out;
}

/** Every INI entry declaring `section`/`key`, across the main INI and #INCLUDEs. */
function iniEntryLocations(model: MachineModel, section: string, key: string): Location[] {
  const out: Location[] = [];
  for (const ini of [model.ini, ...model.iniIncludes]) {
    if (!ini) continue;
    const sec = findSection(ini.ini, section);
    if (!sec) continue;
    for (const e of findEntries(sec, key)) {
      out.push({ uri: ini.uri, range: ini.lineIndex.rangeAt(e.key.start, e.key.end) });
    }
  }
  return out;
}

function scanPinOccurrences(files: HalFileInput[], pinName: string): Location[] {
  const out: Location[] = [];
  for (const f of files) {
    for (const stmt of f.hal.statements) {
      if (stmt.kind === 'net') {
        // Merge contiguous link tokens so an embedded-INI pin
        // (hm2_[HOSTMOT2](BOARD).0.gpio.in) matches by its full name.
        for (const atom of mergeLinkAtoms((stmt as NetStatement).links)) {
          if (atom.text === pinName) {
            const a = atom.tokens[0];
            const b = atom.tokens[atom.tokens.length - 1];
            out.push({ uri: f.uri, range: f.lineIndex.rangeAt(a.start, b.end) });
          }
        }
        continue;
      }
      for (const t of pinTokens(stmt)) {
        if (t.text === pinName) out.push({ uri: f.uri, range: f.lineIndex.rangeAt(t.start, t.end) });
      }
    }
  }
  return out;
}

function pinTokens(stmt: import('@linuxcnc/core').HalStatement): HalToken[] {
  const toks: HalToken[] = [];
  const s = stmt as unknown as Record<string, unknown>;
  if (stmt.kind === 'net') for (const l of (s.links as NetStatement['links'])) toks.push(l.pinToken);
  if (stmt.kind === 'setp' && s.pinToken) toks.push(s.pinToken as HalToken);
  if ((stmt.kind === 'linkps' || stmt.kind === 'linkpp') && s.firstToken) toks.push(s.firstToken as HalToken);
  if (stmt.kind === 'linkpp' && s.secondToken) toks.push(s.secondToken as HalToken);
  if (stmt.kind === 'linksp' && s.secondToken) toks.push(s.secondToken as HalToken);
  if (stmt.kind === 'unlinkp' && s.pinToken) toks.push(s.pinToken as HalToken);
  return toks.filter((t) => t && !t.ini);
}

function sameLoc(a: Location, b: Location): boolean {
  return a.uri === b.uri && a.range.start.line === b.range.start.line && a.range.start.character === b.range.start.character;
}
function eqi(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
