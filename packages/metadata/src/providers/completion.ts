import {
  CompletionItem, CompletionItemKind, MarkupKind, Range, TextEdit,
} from 'vscode-languageserver-types';
import {
  HalFile, LineIndex, IniFile, IniSection,
  HAL_COMMANDS, LoadrtStatement,
} from '@linuxcnc/core';
import { MetadataIndex } from '../db';
import { MachineModel } from '../model/types';
import { ComponentDef, PinDef, ParamDef } from '../types';

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

export interface HalCompletionContext {
  hal: HalFile;
  lineIndex: LineIndex;
  text: string;
  offset: number;
  index: MetadataIndex;
  /** The owning machine model, if any — gives loaded instances/signals/INI. */
  model?: MachineModel;
}

/** Text of the (logical) line up to `offset`, joining backslash continuations. */
function logicalPrefix(text: string, offset: number): { line: string; start: number } {
  let start = offset;
  while (start > 0 && text[start - 1] !== '\n') start--;
  // Walk back over preceding physical lines that end with a backslash continuation.
  let s = start;
  while (s > 0 && text[s - 1] === '\n') {
    let j = s - 2;
    if (j >= 0 && text[j] === '\r') j--;
    if (j >= 0 && text[j] === '\\') {
      let p = j;
      while (p > 0 && text[p - 1] !== '\n') p--;
      s = p;
    } else break;
  }
  // Normalize embedded continuations to single spaces so word splitting is clean.
  const raw = text.slice(s, offset);
  const line = raw.replace(/\\\r?\n/g, ' ');
  return { line, start: s };
}

interface Prefix {
  /** Lowercased first word (the command), if any complete word precedes the cursor. */
  command?: string;
  /** Complete whitespace-separated words before the partial (excludes the command position when empty). */
  words: string[];
  /** The token currently being typed (may be ''). */
  partial: string;
  /** Absolute offset where the partial begins. */
  partialStart: number;
}

function splitPrefix(line: string, offset: number): Prefix {
  const m = /(\S*)$/.exec(line);
  const partial = m ? m[1] : '';
  const before = line.slice(0, line.length - partial.length);
  const words = before.trim().length ? before.trim().split(/\s+/) : [];
  return {
    command: words[0]?.toLowerCase(),
    words,
    partial,
    partialStart: offset - partial.length,
  };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

function md(value: string): { kind: MarkupKind; value: string } {
  return { kind: MarkupKind.Markdown, value };
}

interface MakeOpts {
  kind: CompletionItemKind;
  detail?: string;
  doc?: string;
  /** Text to insert; defaults to the label. */
  insertText?: string;
  /** Range to replace; defaults to the partial range. */
  range?: Range;
  /** Sort priority prefix (lower sorts first). */
  sort?: string;
}

function item(label: string, defaultRange: Range, o: MakeOpts): CompletionItem {
  const insert = o.insertText ?? label;
  const range = o.range ?? defaultRange;
  return {
    label,
    kind: o.kind,
    detail: o.detail,
    documentation: o.doc ? md(o.doc) : undefined,
    filterText: label,
    sortText: (o.sort ?? '5') + label,
    textEdit: TextEdit.replace(range, insert),
  };
}

function prefixMatch(candidate: string, partial: string): boolean {
  if (!partial) return true;
  return candidate.toLowerCase().startsWith(partial.toLowerCase());
}

// ---------------------------------------------------------------------------
// HAL completion
// ---------------------------------------------------------------------------

export function completeHal(ctx: HalCompletionContext): CompletionItem[] {
  const { text, offset, lineIndex } = ctx;
  const { line } = logicalPrefix(text, offset);
  const px = splitPrefix(line, offset);
  const range = lineIndex.rangeAt(px.partialStart, offset);

  // 1. INI reference (`[SEC]KEY`) — may appear in any value position. Only when a
  //    command has already been typed (avoids hijacking line-start `[`).
  if (px.words.length >= 1) {
    const ini = iniRefCompletion(ctx, px, offset);
    if (ini) return ini;
  }

  // 2. First word -> command completion.
  if (px.words.length === 0) {
    return commandCompletions(ctx.index, px.partial, range);
  }

  // 3. Dispatch by command.
  const tokenIndex = px.words.length; // 0-based index of the token being completed
  switch (px.command) {
    case 'loadrt':
      return loadrtCompletions(ctx, px, range, tokenIndex);
    case 'addf':
    case 'delf':
    case 'initf':
      if (tokenIndex === 1) return functionCompletions(ctx, px.partial, range);
      if (tokenIndex === 2) return threadCompletions(ctx, px.partial, range);
      return [];
    case 'net':
      if (tokenIndex === 1) return signalCompletions(ctx, px.partial, range);
      return pinCompletions(ctx, px.partial, range, 'all');
    case 'setp':
      if (tokenIndex === 1) return pinCompletions(ctx, px.partial, range, 'writable');
      return [];
    case 'sets':
    case 'newsig':
    case 'delsig':
    case 'gets':
      if (tokenIndex === 1) return signalCompletions(ctx, px.partial, range);
      return [];
    case 'getp':
    case 'ptype':
    case 'stype':
    case 'unlinkp':
      if (tokenIndex === 1) return pinCompletions(ctx, px.partial, range, 'all');
      return [];
    case 'linkps': // linkps pin signal
      return tokenIndex === 1
        ? pinCompletions(ctx, px.partial, range, 'all')
        : signalCompletions(ctx, px.partial, range);
    case 'linksp': // linksp signal pin
      return tokenIndex === 1
        ? signalCompletions(ctx, px.partial, range)
        : pinCompletions(ctx, px.partial, range, 'all');
    case 'linkpp': // linkpp pin pin
      return pinCompletions(ctx, px.partial, range, 'all');
    case 'unloadrt':
    case 'unload':
      return unloadCompletions(ctx, px.partial, range);
    default:
      return [];
  }
}

function commandCompletions(index: MetadataIndex, partial: string, range: Range): CompletionItem[] {
  const out: CompletionItem[] = [];
  for (const name of HAL_COMMANDS) {
    if (!prefixMatch(name, partial)) continue;
    const def = index.command(name);
    out.push(item(name, range, {
      kind: CompletionItemKind.Keyword,
      detail: def?.signature,
      doc: def?.doc,
    }));
  }
  return out;
}

function loadrtCompletions(
  ctx: HalCompletionContext,
  px: Prefix,
  range: Range,
  tokenIndex: number,
): CompletionItem[] {
  // Component position (immediately after `loadrt`).
  if (tokenIndex === 1) {
    return componentCompletions(ctx.index, px.partial, range);
  }
  // After the component: instantiation keys + the component's modparams.
  const compName = px.words[1];
  const comp = ctx.index.component(compName);
  const out: CompletionItem[] = [];
  // Typing a `key=` value? offer little (values are user data); only config= for Mesa.
  const eq = px.partial.indexOf('=');
  if (eq >= 0) {
    return out; // value side — nothing reliable to suggest
  }
  const std: Array<[string, string]> = [
    ['names=', 'Comma-separated instance names (e.g. names=pid.x,pid.y)'],
    ['count=', 'Number of instances to create'],
  ];
  if (comp?.instanceNaming === 'mesa' || /^hm2_/.test(compName)) {
    std.push(['config=', 'Mesa firmware config string, e.g. config="num_encoders=3 num_stepgens=5"']);
  }
  for (const [k, doc] of std) {
    if (prefixMatch(k, px.partial)) out.push(item(k, range, { kind: CompletionItemKind.Property, doc, sort: '3' }));
  }
  if (comp) {
    for (const mp of comp.modparams) {
      const lbl = mp.name + '=';
      if (!prefixMatch(lbl, px.partial)) continue;
      out.push(item(lbl, range, {
        kind: CompletionItemKind.Property,
        detail: mp.type,
        doc: mp.doc,
        sort: '4',
      }));
    }
  }
  return out;
}

function componentCompletions(index: MetadataIndex, partial: string, range: Range): CompletionItem[] {
  const out: CompletionItem[] = [];
  for (const name of index.componentNames()) {
    if (!prefixMatch(name, partial)) continue;
    const c = index.component(name);
    out.push(item(name, range, {
      kind: CompletionItemKind.Module,
      detail: c?.description ?? summarize(c),
      doc: c?.descriptionMd,
    }));
  }
  return out;
}

function summarize(c: ComponentDef | undefined): string | undefined {
  if (!c) return undefined;
  const parts: string[] = [];
  if (c.pins.length) parts.push(`${c.pins.length} pins`);
  if (c.functions.length) parts.push(`${c.functions.length} funcs`);
  return parts.join(' · ') || undefined;
}

function functionCompletions(ctx: HalCompletionContext, partial: string, range: Range): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, detail: string, doc?: string) => {
    if (seen.has(name) || !prefixMatch(name, partial)) return;
    seen.add(name);
    out.push(item(name, range, { kind: CompletionItemKind.Function, detail, doc }));
  };
  for (const inst of instances(ctx)) {
    const comp = ctx.index.component(inst.comp);
    if (!comp) continue;
    for (const fn of comp.functions) {
      if (fn.global) add(fn.name, `function · ${comp.name}`, fn.doc);
      else if (fn.name === '') add(inst.name, `function · ${comp.name}`, fn.doc);
      else add(`${inst.name}.${fn.name}`, `function · ${comp.name}`, fn.doc);
    }
  }
  return out;
}

function threadCompletions(ctx: HalCompletionContext, partial: string, range: Range): CompletionItem[] {
  const names = new Set<string>(['servo-thread', 'base-thread']);
  // Threads created via `loadrt threads name1=...`.
  for (const f of halFiles(ctx)) {
    for (const stmt of f.statements) {
      if (stmt.kind !== 'loadrt') continue;
      const s = stmt as LoadrtStatement;
      if (s.componentToken?.text !== 'threads') continue;
      for (const mp of s.modparams) {
        if (/^name\d+$/i.test(mp.nameToken.text) && mp.valueToken) names.add(mp.valueToken.text);
      }
    }
  }
  return [...names]
    .filter((n) => prefixMatch(n, partial))
    .map((n) => item(n, range, { kind: CompletionItemKind.Event, detail: 'thread' }));
}

function signalCompletions(ctx: HalCompletionContext, partial: string, range: Range): CompletionItem[] {
  const names = new Set<string>();
  if (ctx.model) {
    for (const name of ctx.model.signals.keys()) names.add(name);
  } else {
    // Derive from the current file's net/newsig/sets statements.
    for (const f of halFiles(ctx)) {
      for (const stmt of f.statements) {
        const s = stmt as unknown as Record<string, { text?: string } | undefined>;
        const t = s.signalToken;
        if (t?.text) names.add(t.text);
      }
    }
  }
  return [...names]
    .filter((n) => prefixMatch(n, partial))
    .map((n) => item(n, range, { kind: CompletionItemKind.Variable, detail: 'signal' }));
}

type PinFilter = 'all' | 'writable';

function pinCompletions(ctx: HalCompletionContext, partial: string, range: Range, filter: PinFilter): CompletionItem[] {
  const out: CompletionItem[] = [];
  // Absolute (motion: joint.N.* / axis.L.* / spindle.N.* / motion.*) pins.
  out.push(...absolutePinCompletions(ctx.index, partial, range, filter));
  // Per-instance pins.
  for (const inst of instances(ctx)) {
    const comp = ctx.index.component(inst.comp);
    if (!comp || comp.absolute) continue; // absolute handled above
    for (const p of comp.pins) {
      if (filter === 'writable' && p.dir === 'out') continue;
      const full = `${inst.name}.${p.name}`;
      if (!prefixMatch(full, partial)) continue;
      out.push(item(full, range, { kind: pinKind(p), detail: `${p.type} ${p.dir} pin · ${comp.name}`, doc: p.doc, sort: '4' }));
    }
    if (filter === 'writable') {
      for (const p of comp.params) {
        if (p.dir === 'ro') continue;
        const full = `${inst.name}.${p.name}`;
        if (!prefixMatch(full, partial)) continue;
        out.push(item(full, range, { kind: CompletionItemKind.Field, detail: `${p.type} ${p.dir} param · ${comp.name}`, doc: p.doc, sort: '4' }));
      }
    }
  }
  return out;
}

function pinKind(p: PinDef | ParamDef): CompletionItemKind {
  return 'dir' in p && (p as PinDef).dir === 'out' ? CompletionItemKind.Field : CompletionItemKind.Property;
}

/** Offer motion's absolute pins, substituting a concrete joint/spindle index when
 *  the partial already specifies one (e.g. `joint.0.` -> `joint.0.home-sw-in`). */
function absolutePinCompletions(index: MetadataIndex, partial: string, range: Range, filter: PinFilter): CompletionItem[] {
  const motion = index.component('motion');
  if (!motion || !motion.absolute) return [];
  // Only engage when the partial looks like a motion pin (or is empty after a prefix word).
  if (partial && !/^(joint|axis|spindle|motion)\b/i.test(partial)) return [];
  const out: CompletionItem[] = [];
  const idx = /^(joint|spindle)\.(\d+)\./.exec(partial);
  const seen = new Set<string>();
  const push = (name: string, p: PinDef) => {
    if (filter === 'writable' && p.dir === 'out') return;
    if (seen.has(name) || !prefixMatch(name, partial)) return;
    seen.add(name);
    out.push(item(name, range, { kind: pinKind(p), detail: `${p.type} ${p.dir} pin · motion`, doc: p.doc, sort: '4' }));
  };
  for (const p of motion.pins) {
    if (idx && (p.name.startsWith('joint.N.') || p.name.startsWith('spindle.N.'))) {
      // Substitute the concrete index the user already typed.
      const tmpl = `${idx[1]}.N.`;
      if (!p.name.startsWith(tmpl)) continue;
      push(`${idx[1]}.${idx[2]}.${p.name.slice(tmpl.length)}`, p);
    } else if (!/\b[NL]\b/.test(p.name) && !p.name.includes('.N.') && !p.name.includes('.L.')) {
      // Concrete name already (axis.x.*, motion.*).
      push(p.name, p);
    }
  }
  return out;
}

function unloadCompletions(ctx: HalCompletionContext, partial: string, range: Range): CompletionItem[] {
  const names = new Set<string>();
  for (const inst of instances(ctx)) names.add(inst.comp);
  return [...names]
    .filter((n) => prefixMatch(n, partial))
    .map((n) => item(n, range, { kind: CompletionItemKind.Reference, detail: 'loaded component' }));
}

// --- INI references inside HAL ---------------------------------------------

function iniRefCompletion(ctx: HalCompletionContext, px: Prefix, offset: number): CompletionItem[] | null {
  const p = px.partial;
  // Section: `[` then a partial section name, not yet closed.
  const sec = /^\[([^\]]*)$/.exec(p);
  if (sec) {
    const keyStart = px.partialStart + 1; // just after `[`
    const range = ctx.lineIndex.rangeAt(keyStart, offset);
    return iniSectionNames(ctx)
      .filter((s) => prefixMatch(s, sec[1]))
      .map((s) => item(s, range, { kind: CompletionItemKind.Module, detail: 'INI section', insertText: `${s}]` }));
  }
  // Key: `[SEC]` (optionally `(`) then a partial key name.
  const key = /^\[([^\]]+)\](\()?([A-Za-z0-9_]*)$/.exec(p);
  if (key) {
    const section = key[1];
    const keyPrefix = key[3];
    const range = ctx.lineIndex.rangeAt(offset - keyPrefix.length, offset);
    return iniSectionKeys(ctx, section)
      .filter((k) => prefixMatch(k.name, keyPrefix))
      .map((k) => item(k.name, range, { kind: CompletionItemKind.Field, detail: k.type ? `INI key · ${k.type}` : 'INI key', doc: k.doc }));
  }
  return null;
}

function iniSectionNames(ctx: HalCompletionContext): string[] {
  const names = new Set<string>();
  for (const f of iniFiles(ctx)) for (const s of f.sections) names.add(s.name.text);
  if (!names.size) {
    // Fall back to documented schema sections (orphan HAL / no machine INI).
    for (const name of Object.keys(ctx.index.raw().iniSections)) names.add(friendlySection(name));
  }
  return [...names];
}

function iniSectionKeys(ctx: HalCompletionContext, section: string): Array<{ name: string; type?: string; doc?: string }> {
  const out = new Map<string, { name: string; type?: string; doc?: string }>();
  // Keys actually present in the machine INI section(s).
  for (const f of iniFiles(ctx)) {
    for (const s of f.sections) {
      if (s.name.text.toLowerCase() !== section.toLowerCase()) continue;
      for (const e of s.entries) if (!out.has(e.key.text)) out.set(e.key.text, { name: e.key.text });
    }
  }
  // Enrich / fall back with documented schema keys.
  const schema = ctx.index.iniSection(section);
  if (schema) {
    for (const def of Object.values(schema.keys)) {
      const existing = out.get(def.key);
      if (existing) { existing.type = def.type; existing.doc = def.docMd ?? def.doc; }
      else out.set(def.key, { name: def.key, type: def.type, doc: def.docMd ?? def.doc });
    }
  }
  return [...out.values()];
}

function friendlySection(name: string): string {
  return name
    .replace(/_<num>$/i, '_0')
    .replace(/_<letter>$/i, '_X');
}

// --- shared accessors -------------------------------------------------------

function halFiles(ctx: HalCompletionContext): HalFile[] {
  if (ctx.model && ctx.model.files.length) return ctx.model.files.map((f) => f.hal);
  return [ctx.hal];
}

function iniFiles(ctx: HalCompletionContext): IniFile[] {
  const out: IniFile[] = [];
  if (ctx.model?.ini) out.push(ctx.model.ini.ini);
  if (ctx.model) for (const inc of ctx.model.iniIncludes) out.push(inc.ini);
  return out;
}

interface InstInfo { name: string; comp: string; }

function instances(ctx: HalCompletionContext): InstInfo[] {
  if (ctx.model) return [...ctx.model.instances.values()].map((i) => ({ name: i.name, comp: i.comp }));
  // Derive from the current file's loadrt statements.
  const out: InstInfo[] = [];
  const seen = new Set<string>();
  const reg = (name: string, comp: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, comp });
  };
  for (const stmt of ctx.hal.statements) {
    if (stmt.kind !== 'loadrt') continue;
    const s = stmt as LoadrtStatement;
    const comp = s.componentToken;
    if (!comp || comp.ini) continue;
    if (s.names?.length) for (const n of s.names) reg(n, comp.text);
    else if (typeof s.count === 'number') for (let i = 0; i < s.count; i++) reg(`${comp.text}.${i}`, comp.text);
    else { reg(`${comp.text}.0`, comp.text); reg(comp.text, comp.text); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// INI file completion
// ---------------------------------------------------------------------------

export interface IniCompletionContext {
  ini: IniFile;
  lineIndex: LineIndex;
  text: string;
  offset: number;
  index: MetadataIndex;
}

export function completeIni(ctx: IniCompletionContext): CompletionItem[] {
  const { text, offset, lineIndex, ini, index } = ctx;
  const { line, start } = logicalPrefix(text, offset);
  const trimmed = line.replace(/^\s+/, '');
  const leading = line.length - trimmed.length;

  // Section header: line starts with `[`.
  if (trimmed.startsWith('[')) {
    const inner = trimmed.slice(1).replace(/\].*$/, '');
    const range = lineIndex.rangeAt(start + leading + 1, offset);
    const names = new Set<string>();
    for (const s of ini.sections) names.add(s.name.text);
    for (const name of Object.keys(index.raw().iniSections)) names.add(friendlySection(name));
    return [...names]
      .filter((n) => prefixMatch(n, inner))
      .map((n) => item(n, range, { kind: CompletionItemKind.Module, detail: 'INI section', insertText: `${n}]` }));
  }

  // Key position: typing a key (no `=` yet on the line).
  if (line.includes('=')) return [];
  const section = sectionAtOffset(ini, offset);
  if (!section) return [];
  const schema = index.iniSection(section.name.text);
  if (!schema) return [];
  const present = new Set(section.entries.map((e) => e.key.text.toLowerCase()));
  const range = lineIndex.rangeAt(start + leading, offset);
  const out: CompletionItem[] = [];
  for (const def of Object.values(schema.keys)) {
    if (!prefixMatch(def.key, trimmed)) continue;
    const already = present.has(def.key.toLowerCase());
    out.push(item(def.key, range, {
      kind: CompletionItemKind.Field,
      detail: def.type ? `${def.type}${already ? ' · already set' : ''}` : (already ? 'already set' : 'INI key'),
      doc: def.docMd ?? def.doc,
      insertText: `${def.key} = `,
      sort: already ? '6' : '4',
    }));
  }
  return out;
}

function sectionAtOffset(ini: IniFile, offset: number): IniSection | undefined {
  let best: IniSection | undefined;
  for (const s of ini.sections) {
    if (offset >= s.headerStart && offset <= s.end) {
      if (!best || s.headerStart > best.headerStart) best = s;
    }
  }
  return best;
}
