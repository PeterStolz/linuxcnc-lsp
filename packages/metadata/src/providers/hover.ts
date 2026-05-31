import { Hover, MarkupKind, Range } from 'vscode-languageserver-types';
import {
  HalFile, HalStatement, HalToken, LineIndex,
  LoadrtStatement, NetStatement, SetpStatement, SetsStatement,
  IniFile,
} from '@linuxcnc/core';
import { MetadataIndex } from '../db';
import { ComponentDef, PinDef, ParamDef, FuncDef } from '../types';

function md(value: string, range?: Range): Hover {
  return { contents: { kind: MarkupKind.Markdown, value }, range };
}

function inTok(t: HalToken | undefined, offset: number): t is HalToken {
  return !!t && offset >= t.start && offset <= t.end;
}

// ---------------------------------------------------------------------------
// HAL hover
// ---------------------------------------------------------------------------

export function hoverHal(
  hal: HalFile,
  lineIndex: LineIndex,
  offset: number,
  index: MetadataIndex,
): Hover | null {
  for (const stmt of hal.statements) {
    if (offset < stmt.start || offset > stmt.end) continue;

    if (inTok(stmt.commandToken, offset) && stmt.command) {
      return commandHover(stmt.command, index, range(lineIndex, stmt.commandToken));
    }

    const h = hoverInStatement(stmt, lineIndex, offset, index);
    if (h) return h;
  }
  return null;
}

function hoverInStatement(
  stmt: HalStatement,
  lineIndex: LineIndex,
  offset: number,
  index: MetadataIndex,
): Hover | null {
  switch (stmt.kind) {
    case 'loadrt': {
      const s = stmt as LoadrtStatement;
      if (inTok(s.componentToken, offset)) {
        if (s.componentToken.ini) return iniRefHover(s.componentToken, index, lineIndex);
        return componentHover(s.componentToken.text, index, range(lineIndex, s.componentToken));
      }
      for (const mp of s.modparams) {
        if (inTok(mp.valueToken, offset) && mp.valueToken!.ini) {
          return iniRefHover(mp.valueToken!, index, lineIndex);
        }
      }
      return null;
    }
    case 'net': {
      const s = stmt as NetStatement;
      if (inTok(s.signalToken, offset)) {
        return signalHover(s.signalToken.text, range(lineIndex, s.signalToken));
      }
      for (const l of s.links) {
        if (inTok(l.pinToken, offset)) {
          if (l.pinToken.ini) return iniRefHover(l.pinToken, index, lineIndex);
          return pinHover(l.pinToken.text, index, range(lineIndex, l.pinToken));
        }
      }
      return null;
    }
    case 'setp': {
      const s = stmt as SetpStatement;
      if (inTok(s.pinToken, offset)) return pinHover(s.pinToken.text, index, range(lineIndex, s.pinToken));
      if (inTok(s.valueToken, offset) && s.valueToken!.ini) return iniRefHover(s.valueToken!, index, lineIndex);
      return null;
    }
    case 'sets': {
      const s = stmt as SetsStatement;
      if (inTok(s.signalToken, offset)) return signalHover(s.signalToken.text, range(lineIndex, s.signalToken));
      if (inTok(s.valueToken, offset) && s.valueToken!.ini) return iniRefHover(s.valueToken!, index, lineIndex);
      return null;
    }
    case 'addf':
    case 'initf':
    case 'delf': {
      const s = stmt as unknown as Record<string, HalToken | undefined>;
      if (inTok(s.functionToken, offset)) return functionHover(s.functionToken!.text, index, range(lineIndex, s.functionToken!));
      if (inTok(s.threadToken, offset)) return md(`**thread** \`${s.threadToken!.text}\``, range(lineIndex, s.threadToken!));
      return null;
    }
    case 'linkps':
    case 'linksp':
    case 'linkpp': {
      const s = stmt as unknown as Record<string, HalToken | undefined>;
      for (const key of ['firstToken', 'secondToken']) {
        const t = s[key];
        if (inTok(t, offset)) {
          // pin for linkps.first/linkpp.*; otherwise a signal
          if (stmt.kind === 'linkps' && key === 'secondToken') return signalHover(t!.text, range(lineIndex, t!));
          if (stmt.kind === 'linksp' && key === 'firstToken') return signalHover(t!.text, range(lineIndex, t!));
          return pinHover(t!.text, index, range(lineIndex, t!));
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function range(lineIndex: LineIndex, t: HalToken): Range {
  return lineIndex.rangeAt(t.start, t.end);
}

function commandHover(cmd: string, index: MetadataIndex, r: Range): Hover | null {
  const c = index.command(cmd);
  if (!c) return null;
  return md(`\`\`\`\n${c.signature}\n\`\`\`\n\n${c.doc ?? ''}`, r);
}

function componentHover(name: string, index: MetadataIndex, r: Range): Hover | null {
  const c = index.component(name);
  if (!c) return null;
  return md(renderComponent(c), r);
}

/** Max rows shown per pin/param/function section before truncating, so a
 *  component with hundreds of members (e.g. a driver) can't blow up the hover. */
const MAX_MEMBER_ROWS = 50;

function renderComponent(c: ComponentDef): string {
  const lines: string[] = [`### \`${c.name}\` (HAL component)`];
  if (c.description) lines.push('', c.description);
  else if (c.descriptionMd) lines.push('', c.descriptionMd.split('\n').slice(0, 8).join('\n'));

  const counts: string[] = [];
  if (c.pins.length) counts.push(`${c.pins.length} pins`);
  if (c.params.length) counts.push(`${c.params.length} parameter${c.params.length === 1 ? '' : 's'}`);
  if (c.functions.length) counts.push(`${c.functions.length} function${c.functions.length === 1 ? '' : 's'}`);
  if (counts.length) lines.push('', `_${counts.join(' · ')}_`);

  if (c.pins.length) lines.push('', '**Pins**', '', ...memberTable(c.pins));
  if (c.params.length) lines.push('', '**Parameters**', '', ...memberTable(c.params));
  const fns = renderFunctions(c.functions);
  if (fns.length) lines.push('', '**Functions**', '', ...fns);

  if (c.modparams.length) {
    lines.push('', '**loadrt parameters:** ' + c.modparams.map((m) => `\`${m.name}\``).join(', '));
  }

  const footer: string[] = [];
  if (c.author) footer.push(`Author: ${c.author}`);
  if (c.license) footer.push(`License: ${c.license}`);
  if (footer.length) lines.push('', `_${footer.join(' · ')}_`);
  if (c.seeAlso) lines.push('', `See also: ${c.seeAlso}`);
  return lines.join('\n');
}

/** Sanitize free text for a single GFM table cell: collapse newlines/runs of
 *  whitespace to single spaces and escape the pipe delimiter. */
function cell(s: string | undefined): string {
  return s ? s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() : '';
}

/** Render pins or params as a GFM table (Name · Type · Dir · Description). */
function memberTable(members: Array<PinDef | ParamDef>): string[] {
  const rows = ['| Name | Type | Dir | Description |', '| --- | --- | --- | --- |'];
  for (const m of members.slice(0, MAX_MEMBER_ROWS)) {
    rows.push(`| \`${m.name}\` | ${m.type} | ${m.dir} | ${cell(m.doc)} |`);
  }
  if (members.length > MAX_MEMBER_ROWS) {
    rows.push(`| … | | | _${members.length - MAX_MEMBER_ROWS} more_ |`);
  }
  return rows;
}

function renderFunctions(fns: FuncDef[]): string[] {
  const out: string[] = [];
  for (const f of fns.slice(0, MAX_MEMBER_ROWS)) {
    const fpNote = f.fp === false ? ' _(no floating point)_' : f.fp ? ' _(uses floating point)_' : '';
    const label = f.name ? `\`${f.name}\`` : '_(unnamed — addf the instance itself)_';
    const scope = f.global ? ' · global' : '';
    out.push(`- ${label}${fpNote}${scope}${f.doc ? ` — ${cell(f.doc)}` : ''}`);
  }
  if (fns.length > MAX_MEMBER_ROWS) out.push(`- _… ${fns.length - MAX_MEMBER_ROWS} more_`);
  return out;
}

function signalHover(name: string, r: Range): Hover {
  return md(`**signal** \`${name}\``, r);
}

/** Resolve a full HAL pin name to its component + def using a best-effort
 *  heuristic (the machine model in P3 makes this exact). */
function resolvePin(
  fullName: string,
  index: MetadataIndex,
): { comp: ComponentDef; member: PinDef | ParamDef; kind: 'pin' | 'param' } | null {
  // Absolute builtins: joint.N.* / axis.L.* / motion.* / spindle.N.*
  const builtin = index.builtinPin(fullName);
  if (builtin) return { comp: builtin.comp, member: builtin.pin, kind: 'pin' };

  const parts = fullName.split('.');
  const comp = index.componentByPrefix(parts[0]);
  if (!comp) return null;
  // Try instanced (strip comp.<inst>.) then singleton (strip comp.)
  for (const suffix of [parts.slice(2).join('.'), parts.slice(1).join('.')]) {
    if (!suffix) continue;
    const pin = comp.pins.find((p) => sameMember(p.name, suffix));
    if (pin) return { comp, member: pin, kind: 'pin' };
    const param = comp.params.find((p) => sameMember(p.name, suffix));
    if (param) return { comp, member: param, kind: 'param' };
  }
  return null;
}

function sameMember(a: string, b: string): boolean {
  return a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');
}

function pinHover(fullName: string, index: MetadataIndex, r: Range): Hover | null {
  const res = resolvePin(fullName, index);
  if (!res) return null;
  const { comp, member, kind } = res;
  const dir = 'dir' in member ? member.dir : '';
  const head = `\`${fullName}\` — **${member.type} ${dir}** ${kind} of \`${comp.name}\``;
  const lines = [head];
  if (member.doc) lines.push('', member.doc);
  return md(lines.join('\n'), r);
}

function functionHover(fullName: string, index: MetadataIndex, r: Range): Hover | null {
  const parts = fullName.split('.');
  const comp = index.componentByPrefix(parts[0]);
  if (!comp) return null;
  // global function (e.g. stepgen.make-pulses) or instance.suffix / bare instance
  let fn = comp.functions.find((f) => f.global && f.name === fullName);
  if (!fn) {
    const suffix = parts.slice(2).join('.');
    fn = comp.functions.find((f) => !f.global && f.name === suffix);
  }
  if (!fn) return null;
  const fpNote = fn.fp === false ? ' (no floating point)' : fn.fp ? ' (uses floating point)' : '';
  const lines = [`**function** \`${fullName}\`${fpNote} — provided by \`${comp.name}\``];
  if (fn.doc) lines.push('', fn.doc);
  return md(lines.join('\n'), r);
}

function iniRefHover(token: HalToken, index: MetadataIndex, lineIndex: LineIndex): Hover {
  const { section, key } = token.ini!;
  return md(renderIniKey(section, key, index), range(lineIndex, token));
}

/** Human-readable label for a documented INI value type. */
function typeLabel(type: string): string {
  const t = type.toLowerCase();
  const map: Record<string, string> = {
    real: 'real — a floating-point number (e.g. `3.5`, `1e-6`)',
    int: 'int — a whole number (e.g. `4`)',
    u32: 'u32 — a non-negative whole number',
    u64: 'u64 — a non-negative whole number',
    s32: 's32 — a whole number',
    s64: 's64 — a whole number',
    bool: 'bool — `1`/`0`, `TRUE`/`FALSE` or `YES`/`NO`',
    bit: 'bit — `1` or `0`',
    string: 'string — free text',
    enum: 'enum — one of a fixed set of values (see below)',
  };
  return map[t] ?? type;
}

function renderIniKey(section: string, key: string, index: MetadataIndex, value?: string): string {
  // Homing keys get the full docs section rendered.
  const homing = index.homingDoc(key);
  if (homing && /^JOINT_/i.test(section)) {
    const lines = [`### \`[${section}]${key}\` (homing)`];
    if (value !== undefined) lines.push('', `Value: \`${value}\``);
    lines.push('', homing);
    return lines.join('\n');
  }
  const def = index.iniKey(section, key);
  const lines = [`### \`[${section}]${key}\``];
  if (value !== undefined) lines.push('', `Value: \`${value}\``);
  if (def?.type) lines.push('', `_type: ${typeLabel(def.type)}_`);
  if (def?.docMd) lines.push('', def.docMd);
  else if (def?.doc) lines.push('', def.doc);
  else lines.push('', `_Custom INI variable (not part of the documented LinuxCNC schema)._`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// INI hover
// ---------------------------------------------------------------------------

/** Optional cross-file info for INI hover: how many HAL `[SEC]KEY` refs point at
 *  this key. When provided, the key hover gains a "referenced by N" annotation. */
export type IniRefCount = (section: string, key: string) => number;

export function hoverIni(
  ini: IniFile,
  lineIndex: LineIndex,
  offset: number,
  index: MetadataIndex,
  refCount?: IniRefCount,
): Hover | null {
  for (const section of ini.sections) {
    if (offset >= section.name.start && offset <= section.name.end) {
      const schema = index.iniSection(section.name.text);
      const lines = [`### \`[${section.name.text}]\` section`];
      if (schema?.docMd) lines.push('', schema.docMd);
      return md(lines.join('\n'), lineIndex.rangeAt(section.name.start, section.name.end));
    }
    if (offset < section.start || offset > section.end) continue;
    for (const entry of section.entries) {
      if (offset >= entry.key.start && offset <= entry.key.end) {
        let body = renderIniKey(section.name.text, entry.key.text, index, entry.value?.text);
        if (refCount) {
          body += '\n\n' + iniRefAnnotation(section.name.text, entry.key.text, index, refCount);
        }
        return md(body, lineIndex.rangeAt(entry.key.start, entry.key.end));
      }
    }
  }
  return null;
}

/** Render the cross-reference status line for an INI key. */
function iniRefAnnotation(section: string, key: string, index: MetadataIndex, refCount: IniRefCount): string {
  const n = refCount(section, key);
  if (n > 0) return `📎 Referenced by **${n}** HAL location${n === 1 ? '' : 's'}.`;
  // Not referenced from HAL. Many keys are read directly by LinuxCNC core, so
  // only flag the genuinely-orphaned ones.
  if (index.isRuntimeConsumed(key) || index.iniKey(section, key)) {
    return `_Read directly by LinuxCNC core (no HAL reference needed)._`;
  }
  return `⚠️ Not referenced by any HAL file in this machine.`;
}
