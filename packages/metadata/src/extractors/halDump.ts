import { HalType, PinDir, ParamDir, PinDef, ParamDef, FuncDef } from '../types';

export interface DumpedComponent {
  name: string;
  absolute: boolean;
  pins: PinDef[];
  params: ParamDef[];
  functions: FuncDef[];
  /** An example instance prefix observed in the dump (for diagnostics). */
  instanceExample?: string;
}

function toHalType(s: string): HalType {
  switch (s) {
    case 'bit': case 'float': case 's32': case 'u32': case 's64': case 'u64': case 'port':
      return s;
    default:
      return 'unknown';
  }
}

const PIN_ROW = /^\s*\d+\s+(bit|float|s32|u32|s64|u64|port)\s+(IN|OUT|IO)\s+\S+\s+(\S.*)$/;
const PARAM_ROW = /^\s*\d+\s+(bit|float|s32|u32|s64|u64|port)\s+(RW|RO)\s+\S+\s+(\S.*)$/;
const FUNCT_ROW = /^\s*[0-9a-fA-F]{4,}\s+[0-9a-fA-F]+\s+\S+\s+(YES|NO)\s+\d+\s+(\S.*)$/;

interface RawRow {
  type?: HalType;
  dir: string;
  name: string;
  fp?: boolean;
}

function parseBlock(lines: string[]): { pins: RawRow[]; params: RawRow[]; functs: RawRow[] } {
  const pins: RawRow[] = [];
  const params: RawRow[] = [];
  const functs: RawRow[] = [];
  let section: 'pin' | 'param' | 'funct' | undefined;
  for (const line of lines) {
    if (/Component Pins:/.test(line)) { section = 'pin'; continue; }
    if (/^Parameters:/.test(line)) { section = 'param'; continue; }
    if (/Exported Functions:/.test(line)) { section = 'funct'; continue; }
    if (/^Owner/.test(line)) continue;
    if (section === 'pin') {
      const m = PIN_ROW.exec(line);
      if (m) pins.push({ type: toHalType(m[1]), dir: m[2], name: m[3].trim() });
    } else if (section === 'param') {
      const m = PARAM_ROW.exec(line);
      if (m) params.push({ type: toHalType(m[1]), dir: m[2], name: m[3].trim() });
    } else if (section === 'funct') {
      const m = FUNCT_ROW.exec(line);
      if (m) functs.push({ dir: '', name: m[2].trim(), fp: m[1] === 'YES' });
    }
  }
  return { pins, params, functs };
}

/**
 * Detect the instance prefix to strip from a component's pin/param names.
 *
 * Components expose per-instance pins like `stepgen.0.counts` but ALSO global
 * function-timing pins like `stepgen.make-pulses.time`, so a strict longest
 * common prefix is wrong. We pick the dominant two-segment prefix (`stepgen.0`)
 * when it covers most names (instanced component); otherwise fall back to the
 * single first segment (`charge-pump.`) for singletons.
 */
interface Stripper {
  /** Map a HAL name to its instance-relative suffix, or null to drop it. */
  toSuffix(name: string): string | null;
  numericInstanced: boolean;
  instanceExample?: string;
}

/**
 * Decide how to turn full HAL names into instance-relative suffixes.
 * - Numeric-instanced (and2.0, pid.0/1/2, stepgen.0): the 2nd segment is a
 *   number. Strip the first two segments; DROP names whose 2nd segment is not
 *   numeric (global function-timing pins like stepgen.make-pulses.time).
 * - Singleton / named-instance (charge-pump.out, or a names= instance): strip
 *   the first segment only.
 */
function buildStripper(names: string[]): Stripper {
  if (names.length === 0) return { toSuffix: (n) => n, numericInstanced: false };
  const seg1 = names.map((n) => n.split('.')[1]).filter((s): s is string => !!s);
  const numericFrac = seg1.filter((s) => /^\d+$/.test(s)).length / Math.max(seg1.length, 1);
  if (numericFrac >= 0.5) {
    const example = names.find((n) => /^[^.]+\.\d+(\.|$)/.test(n));
    return {
      numericInstanced: true,
      instanceExample: example ? example.split('.').slice(0, 2).join('.') : undefined,
      toSuffix(name: string): string | null {
        const parts = name.split('.');
        if (parts.length < 2 || !/^\d+$/.test(parts[1])) return null; // global timing pin
        return parts.slice(2).join('.');
      },
    };
  }
  const firstDot = names[0].indexOf('.');
  return {
    numericInstanced: false,
    instanceExample: firstDot >= 0 ? names[0].slice(0, firstDot) : names[0],
    toSuffix(name: string): string {
      const idx = name.indexOf('.');
      return idx >= 0 ? name.slice(idx + 1) : '';
    },
  };
}

/** Replace numeric joint/spindle indices with N and axis letters with L. */
function templatizeAbsolute(name: string): string {
  return name
    .replace(/\b(joint|spindle)\.\d+/g, '$1.N')
    .replace(/\baxis\.[a-w]\b/gi, 'axis.L');
}

function dirToPin(d: string): PinDir {
  return d === 'IN' ? 'in' : d === 'OUT' ? 'out' : 'io';
}

/** Parse the @@@COMP/@@@END dump stream into per-component structural metadata. */
export function parseHalDump(text: string): DumpedComponent[] {
  const out: DumpedComponent[] = [];
  const blocks = text.split(/^@@@COMP\|/m).slice(1);
  for (const block of blocks) {
    const endIdx = block.search(/^@@@END\|/m);
    const body = endIdx >= 0 ? block.slice(0, endIdx) : block;
    const headerLine = body.split('\n', 1)[0];
    const name = headerLine.split('|')[0].trim();
    if (!name) continue;
    const lines = body.split('\n').slice(1);
    const { pins, params, functs } = parseBlock(lines);

    if (name === 'motion') {
      out.push(buildMotion(pins, params, functs));
      continue;
    }

    // Instanced component: turn full HAL names into instance-relative suffixes.
    const allNames = [...pins, ...params].map((r) => r.name);
    const st = buildStripper(allNames);

    const mapPins: PinDef[] = [];
    for (const r of pins) {
      const s = st.toSuffix(r.name);
      if (s === null) continue;
      mapPins.push({ name: s, type: r.type!, dir: dirToPin(r.dir) });
    }
    const mapParams: ParamDef[] = [];
    for (const r of params) {
      const s = st.toSuffix(r.name);
      if (s === null) continue;
      mapParams.push({ name: s, type: r.type!, dir: (r.dir === 'RW' ? 'rw' : 'ro') as ParamDir });
    }
    const mapFns: FuncDef[] = functs.map((r) => {
      const parts = r.name.split('.');
      if (st.numericInstanced) {
        if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
          return { name: parts.slice(2).join('.'), fp: r.fp }; // '' if bare instance fn
        }
        return { name: r.name, fp: r.fp, global: true }; // e.g. stepgen.make-pulses
      }
      const idx = r.name.indexOf('.');
      return { name: idx >= 0 ? r.name.slice(idx + 1) : '', fp: r.fp };
    });

    out.push({
      name,
      absolute: false,
      instanceExample: st.instanceExample,
      pins: dedupe(mapPins),
      params: dedupe(mapParams),
      functions: dedupeFns(mapFns),
    });
  }
  return out;
}

function buildMotion(pins: RawRow[], params: RawRow[], functs: RawRow[]): DumpedComponent {
  return {
    name: 'motion',
    absolute: true,
    pins: dedupe(pins.map((r) => ({ name: templatizeAbsolute(r.name), type: r.type!, dir: dirToPin(r.dir) }))),
    params: dedupe(params.map((r) => ({
      name: templatizeAbsolute(r.name), type: r.type!, dir: (r.dir === 'RW' ? 'rw' : 'ro') as ParamDir,
    }))),
    functions: dedupeFns(functs.map((r) => ({ name: templatizeAbsolute(r.name), fp: r.fp, global: true }))),
  };
}

function dedupe(rows: PinDef[]): PinDef[];
function dedupe(rows: ParamDef[]): ParamDef[];
function dedupe(rows: (PinDef | ParamDef)[]): (PinDef | ParamDef)[] {
  const seen = new Set<string>();
  const out: (PinDef | ParamDef)[] = [];
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

function dedupeFns(rows: FuncDef[]): FuncDef[] {
  const seen = new Set<string>();
  const out: FuncDef[] = [];
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
}
