import {
  HalToken, LoadrtStatement, NetStatement, SetsStatement, NewsigStatement,
  LinkStatement, AliasStatement,
} from '@linuxcnc/core';
import { MetadataIndex } from '../db';
import { HalFileInput, IniFileInput, MachineModel, InstanceInfo, SignalNode, PinRef, Loc } from './types';

export interface BuildInputs {
  iniInput?: IniFileInput;
  /** INI files referenced via #INCLUDE from the main INI (resolved by caller). */
  iniIncludes?: IniFileInput[];
  files: HalFileInput[];
  index: MetadataIndex;
  hasOpaqueFiles?: boolean;
}

export function buildMachineModel({ iniInput, iniIncludes, files, index, hasOpaqueFiles }: BuildInputs): MachineModel {
  const instances = new Map<string, InstanceInfo>();
  const signals = new Map<string, SignalNode>();
  const aliases = new Map<string, string>();

  const ordered = [...files].sort((a, b) => a.order - b.order);

  // Pass 1: collect component instances from loadrt statements.
  for (const f of ordered) {
    for (const stmt of f.hal.statements) {
      if (stmt.kind !== 'loadrt') continue;
      const s = stmt as LoadrtStatement;
      const comp = s.componentToken;
      if (!comp || comp.ini) continue; // skip [INI]-resolved component names
      const loadLoc: Loc = { uri: f.uri, range: f.lineIndex.rangeAt(comp.start, comp.end) };
      const register = (name: string) => {
        if (!instances.has(name)) instances.set(name, { name, comp: comp.text, loadLoc });
      };
      if (s.names && s.names.length) {
        for (const n of s.names) register(n);
      } else if (typeof s.count === 'number') {
        for (let i = 0; i < s.count; i++) register(`${comp.text}.${i}`);
      } else {
        register(`${comp.text}.0`);
        register(comp.text); // singleton fallback
      }
    }
  }

  // Pass 2: aliases (so pin direction lookups can canonicalize).
  for (const f of ordered) {
    for (const stmt of f.hal.statements) {
      if (stmt.kind === 'alias') {
        const s = stmt as AliasStatement;
        if (s.originalToken && s.aliasToken) aliases.set(s.aliasToken.text, s.originalToken.text);
      }
    }
  }

  const resolveDir = (fullName: string): 'in' | 'out' | 'io' | undefined =>
    resolvePinDir(canonical(fullName, aliases), instances, index);

  const sig = (name: string): SignalNode => {
    let n = signals.get(name);
    if (!n) {
      n = { name, writers: [], readers: [], occurrences: [] };
      signals.set(name, n);
    }
    return n;
  };

  // Pass 3: signal graph from net / linkps / linksp / linkpp / sets / newsig.
  for (const f of ordered) {
    const loc = (t: HalToken): Loc => ({ uri: f.uri, range: f.lineIndex.rangeAt(t.start, t.end) });
    for (const stmt of f.hal.statements) {
      switch (stmt.kind) {
        case 'newsig': {
          const s = stmt as NewsigStatement;
          if (s.signalToken) {
            const n = sig(s.signalToken.text);
            n.occurrences.push(loc(s.signalToken));
            n.firstDef ??= loc(s.signalToken);
            if (s.typeToken) n.type ??= s.typeToken.text;
          }
          break;
        }
        case 'net': {
          const s = stmt as NetStatement;
          if (!s.signalToken) break;
          const n = sig(s.signalToken.text);
          n.occurrences.push(loc(s.signalToken));
          n.firstDef ??= loc(s.signalToken);
          // Merge contiguous tokens into one pin atom: a pin name may embed an
          // INI substitution (e.g. hm2_[HOSTMOT2](BOARD).0.stepgen.00.position-fb)
          // which the tokenizer splits into word+iniref+word.
          for (const atom of mergePinAtoms(s.links)) {
            const dir = atom.hasIni ? undefined : resolveDir(atom.text);
            const role = pinRole2(atom.arrow, dir);
            const confident = !!atom.arrow || dir !== undefined;
            const type = atom.hasIni ? undefined : resolveType(atom.text, aliases, instances, index);
            const ref: PinRef = {
              fullName: atom.text,
              loc: { uri: f.uri, range: f.lineIndex.rangeAt(atom.start, atom.end) },
              role, type, confident, resolved: dir !== undefined,
            };
            (role === 'writer' ? n.writers : n.readers).push(ref);
            if (!confident) n.hasUnresolved = true;
            n.type ??= ref.type;
          }
          break;
        }
        case 'linkps': {
          const s = stmt as LinkStatement; // linkps pin [=>] signal
          if (s.firstToken && s.secondToken) {
            const n = sig(s.secondToken.text);
            n.occurrences.push(loc(s.secondToken));
            n.firstDef ??= loc(s.secondToken);
            const role = pinRole(s.firstToken.text, s.arrow, resolveDir);
            (role === 'writer' ? n.writers : n.readers).push({ fullName: s.firstToken.text, loc: loc(s.firstToken), role, resolved: resolveDir(s.firstToken.text) !== undefined });
          }
          break;
        }
        case 'linksp': {
          const s = stmt as LinkStatement; // linksp signal [=>] pin
          if (s.firstToken && s.secondToken) {
            const n = sig(s.firstToken.text);
            n.occurrences.push(loc(s.firstToken));
            n.firstDef ??= loc(s.firstToken);
            const role = pinRole(s.secondToken.text, s.arrow, resolveDir);
            (role === 'writer' ? n.writers : n.readers).push({ fullName: s.secondToken.text, loc: loc(s.secondToken), role, resolved: resolveDir(s.secondToken.text) !== undefined });
          }
          break;
        }
        case 'sets': {
          const s = stmt as SetsStatement;
          if (s.signalToken) {
            const n = sig(s.signalToken.text);
            n.occurrences.push(loc(s.signalToken));
            (n.setBy ??= []).push(loc(s.signalToken));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return {
    iniUri: iniInput?.uri,
    ini: iniInput,
    iniIncludes: iniIncludes ?? [],
    files: ordered,
    instances,
    signals,
    aliases,
    hasOpaqueFiles: !!hasOpaqueFiles,
  };
}

interface PinAtom {
  text: string;
  start: number;
  end: number;
  arrow?: '<=' | '=>' | '<=>';
  hasIni: boolean;
}

/** Group contiguous link tokens (no whitespace between them) into single pin
 *  atoms, so an embedded INI substitution does not split one pin into many. */
function mergePinAtoms(links: NetStatement['links']): PinAtom[] {
  const atoms: PinAtom[] = [];
  let cur: (PinAtom & { lastEnd: number }) | undefined;
  for (const l of links) {
    const t = l.pinToken;
    if (cur && t.start === cur.lastEnd) {
      cur.text += t.text;
      cur.end = t.end;
      cur.lastEnd = t.end;
      cur.hasIni = cur.hasIni || !!t.ini;
      if (!cur.arrow && l.arrow) cur.arrow = l.arrow;
    } else {
      if (cur) atoms.push(cur);
      cur = { text: t.text, start: t.start, end: t.end, lastEnd: t.end, arrow: l.arrow, hasIni: !!t.ini };
    }
  }
  if (cur) atoms.push(cur);
  return atoms;
}

function pinRole2(arrow: '<=' | '=>' | '<=>' | undefined, dir: 'in' | 'out' | 'io' | undefined): 'writer' | 'reader' {
  // Resolved pin direction is authoritative (halcmd derives direction from the
  // pin, not the arrow). io counts as a reader to avoid false multi-writers.
  if (dir === 'out') return 'writer';
  if (dir === 'in' || dir === 'io') return 'reader';
  // Direction unknown (Mesa/unresolved pin): fall back to the arrow hint.
  if (arrow === '<=') return 'writer';
  return 'reader';
}

function canonical(fullName: string, aliases: Map<string, string>): string {
  return aliases.get(fullName) ?? fullName;
}

/** Find the registered instance that is a prefix of `fullName`; return [comp, suffix]. */
export function resolveInstance(
  fullName: string,
  instances: Map<string, InstanceInfo>,
): { comp: string; suffix: string } | undefined {
  let best: string | undefined;
  for (const name of instances.keys()) {
    if (fullName === name || fullName.startsWith(name + '.')) {
      if (!best || name.length > best.length) best = name;
    }
  }
  if (!best) return undefined;
  const info = instances.get(best)!;
  return { comp: info.comp, suffix: fullName === best ? '' : fullName.slice(best.length + 1) };
}

export function resolvePinDir(
  fullName: string,
  instances: Map<string, InstanceInfo>,
  index: MetadataIndex,
): 'in' | 'out' | 'io' | undefined {
  // Absolute builtins (joint.N.* / axis.L.* / motion.* / spindle.N.*)
  const builtin = index.builtinPin(fullName);
  if (builtin) return builtin.pin.dir;
  const r = resolveInstance(fullName, instances);
  if (!r) return undefined;
  const pin = index.pin(r.comp, r.suffix);
  return pin?.dir;
}

function resolveType(
  fullName: string,
  aliases: Map<string, string>,
  instances: Map<string, InstanceInfo>,
  index: MetadataIndex,
): string | undefined {
  const name = canonical(fullName, aliases);
  const builtin = index.builtinPin(name);
  if (builtin) return builtin.pin.type;
  const r = resolveInstance(name, instances);
  if (!r) return undefined;
  return index.pin(r.comp, r.suffix)?.type;
}

function pinRole(
  fullName: string,
  arrow: '<=' | '=>' | '<=>' | undefined,
  resolveDir: (n: string) => 'in' | 'out' | 'io' | undefined,
): 'writer' | 'reader' {
  return pinRole2(arrow, resolveDir(fullName));
}
