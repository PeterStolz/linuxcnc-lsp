// Parser for LinuxCNC `.comp` files (halcompile source). We extract the
// DECLARATION section (before `;;`) for documentation: component description,
// per-pin/param doc strings, function docs, modparams, author/license/etc.
// Grammar reference: src/hal/utils/halcompile.g.

import { HalType, PinDir, ParamDir } from '../types';

export interface CompPinDoc {
  halname: string; // as written, may contain '#' for array index
  dir: PinDir;
  type: HalType;
  doc?: string;
}
export interface CompParamDoc {
  halname: string;
  dir: ParamDir;
  type: HalType;
  doc?: string;
}
export interface CompModparam {
  name: string;
  doc?: string;
  default?: string;
}
export interface ParsedComp {
  name: string;
  description?: string;
  pins: CompPinDoc[];
  params: CompParamDoc[];
  functions: { name: string; doc?: string }[];
  modparams: CompModparam[];
  notes?: string;
  seeAlso?: string;
  examples?: string;
  author?: string;
  license?: string;
}

function toType(s: string): HalType {
  switch (s) {
    case 'float': case 'bit': case 's32': case 'u32': case 's64': case 'u64': case 'port':
      return s;
    case 'signed':
      return 's32';
    case 'unsigned':
      return 'u32';
    default:
      return 'unknown';
  }
}

/** Strip the body (everything from the first top-level `;;`) and C comments. */
function declarationSection(src: string): string {
  // Cut at `;;` (the body separator). `;;` won't appear inside the decl section.
  const bodyIdx = src.indexOf(';;');
  const decl = bodyIdx >= 0 ? src.slice(0, bodyIdx) : src;
  return decl;
}

/** Split the declaration text into statements terminated by `;`, honoring
 *  `"..."`, `"""..."""`, and // and / * * / comments. */
function splitStatements(decl: string): string[] {
  const stmts: string[] = [];
  let buf = '';
  let i = 0;
  const n = decl.length;
  while (i < n) {
    const ch = decl[i];
    // line comment
    if (ch === '/' && decl[i + 1] === '/') {
      while (i < n && decl[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (ch === '/' && decl[i + 1] === '*') {
      i += 2;
      while (i < n && !(decl[i] === '*' && decl[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // triple-quoted string (optionally r-prefixed)
    if (ch === '"' && decl[i + 1] === '"' && decl[i + 2] === '"') {
      const start = i;
      i += 3;
      while (i < n && !(decl[i] === '"' && decl[i + 1] === '"' && decl[i + 2] === '"')) i++;
      i += 3;
      buf += decl.slice(start, i);
      continue;
    }
    // normal string
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && decl[i] !== '"') {
        if (decl[i] === '\\') i++;
        i++;
      }
      i++;
      buf += decl.slice(start, i);
      continue;
    }
    if (ch === ';') {
      if (buf.trim()) stmts.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

/** Extract the (last) quoted string literal from a statement, returning the
 *  decoded content and the statement with that literal removed (the "code"). */
function extractDocString(stmt: string): { code: string; doc?: string } {
  // Find the last string literal.
  const tripleRe = /r?"""([\s\S]*?)"""/g;
  const singleRe = /"((?:\\.|[^"\\])*)"/g;
  let last: { start: number; end: number; content: string } | undefined;
  let m: RegExpExecArray | null;
  while ((m = tripleRe.exec(stmt))) last = { start: m.index, end: tripleRe.lastIndex, content: m[1] };
  if (!last) {
    while ((m = singleRe.exec(stmt))) last = { start: m.index, end: singleRe.lastIndex, content: unescapeStr(m[1]) };
  }
  if (!last) return { code: stmt.trim() };
  const code = (stmt.slice(0, last.start) + ' ' + stmt.slice(last.end)).trim();
  return { code, doc: cleanDoc(last.content) };
}

function unescapeStr(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

function cleanDoc(s: string): string {
  return s.replace(/\r/g, '').trim();
}

const PIN_RE = /^pin\s+(in|out|io)\s+(\S+)\s+(\S+)/;
const PARAM_RE = /^param\s+(rw|r)\s+(\S+)\s+(\S+)/;
const FUNC_RE = /^function\s+(\S+)/;
const MODPARAM_RE = /^modparam\s+(\S+)\s+(\S+)/;
const COMPONENT_RE = /^component\s+(\S+)/;

export function parseCompFile(src: string): ParsedComp | undefined {
  const decl = declarationSection(src);
  const stmts = splitStatements(decl);
  if (stmts.length === 0) return undefined;

  const result: ParsedComp = { name: '', pins: [], params: [], functions: [], modparams: [] };

  for (const stmt of stmts) {
    const { code, doc } = extractDocString(stmt);
    let m: RegExpExecArray | null;
    if ((m = COMPONENT_RE.exec(code))) {
      result.name = m[1];
      result.description = doc;
    } else if ((m = PIN_RE.exec(code))) {
      result.pins.push({ dir: m[1] as PinDir, type: toType(m[2]), halname: stripArray(m[3]), doc });
    } else if ((m = PARAM_RE.exec(code))) {
      result.params.push({
        dir: (m[1] === 'rw' ? 'rw' : 'ro') as ParamDir, type: toType(m[2]), halname: stripArray(m[3]), doc,
      });
    } else if ((m = FUNC_RE.exec(code))) {
      const fname = m[1] === '_' ? '' : m[1];
      result.functions.push({ name: fname, doc });
    } else if ((m = MODPARAM_RE.exec(code))) {
      const def = /=\s*(\S+)/.exec(code);
      result.modparams.push({ name: m[2], doc, default: def?.[1] });
    } else if (/^description\b/.test(code)) {
      if (doc) result.description = result.description ? `${result.description}\n\n${doc}` : doc;
    } else if (/^notes\b/.test(code)) {
      result.notes = doc;
    } else if (/^see_also\b/.test(code)) {
      result.seeAlso = doc;
    } else if (/^examples\b/.test(code)) {
      result.examples = doc;
    } else if (/^author\b/.test(code)) {
      result.author = doc;
    } else if (/^license\b/.test(code)) {
      result.license = doc;
    }
  }
  return result.name ? result : undefined;
}

/** Drop a trailing array spec like `[16]` or `[16:personality]` from a halname. */
function stripArray(halname: string): string {
  return halname.replace(/\[.*$/, '');
}
