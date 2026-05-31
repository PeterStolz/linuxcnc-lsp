// Merge ground-truth structure (halrun dump) with documentation (.comp / man9)
// and the INI schema into a single MetadataDB. Pure (no fs); the regenerate
// script supplies file contents.

import {
  MetadataDB, MetadataSourceInfo, ComponentDef, PinDef, ParamDef, emptyDB, InstanceNaming,
} from './types';
import { DumpedComponent } from './extractors/halDump';
import { ParsedComp } from './extractors/comp';
import { ParsedMan9 } from './extractors/man9';
import { IniSectionSchema } from './types';

export interface AssembleInputs {
  source: MetadataSourceInfo;
  dump: DumpedComponent[];
  comps: ParsedComp[]; // parsed .comp files
  man9: ParsedMan9[];
  iniSections: Record<string, IniSectionSchema>;
  consumedKeys: string[];
  homingKeys: Record<string, string>;
  commands?: MetadataDB['commands'];
  gcodeWords?: MetadataDB['gcodeWords'];
}

function inferNaming(name: string, absolute: boolean): InstanceNaming {
  if (absolute) return 'singleton';
  if (/^hm2_|^hostmot2$/.test(name)) return 'mesa';
  return 'count';
}

/** Map a man9 member key (e.g. `stepgen.N.counts` or `joint.N.home-sw-in`) to
 *  the suffix used for instance-relative pins (`counts`), or keep absolute. */
function man9KeyToSuffix(key: string, compName: string, absolute: boolean): string {
  if (absolute) return key; // motion: joint.N.* matches absolute templates
  // strip leading "<comp>.N." or "<comp>." prefix
  const re = new RegExp(`^${escapeRe(compName)}\\.(?:N\\.)?`);
  return key.replace(re, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assembleDB(input: AssembleInputs): MetadataDB {
  const db = emptyDB(input.source);
  const compByName = new Map(input.comps.map((c) => [c.name, c]));
  const man9ByName = new Map(input.man9.map((m) => [m.name, m]));
  const handled = new Set<string>();

  // 1. Components present in the ground-truth dump (structure is authoritative).
  for (const d of input.dump) {
    handled.add(d.name);
    const comp: ComponentDef = {
      name: d.name,
      sources: ['halrun'],
      pins: d.pins.map((p) => ({ ...p })),
      params: d.params.map((p) => ({ ...p })),
      functions: d.functions.map((f) => ({ ...f })),
      modparams: [],
      absolute: d.absolute || undefined,
      instanceNaming: inferNaming(d.name, d.absolute),
    };
    enrichWithComp(comp, compByName.get(d.name));
    enrichWithMan9(comp, man9ByName.get(d.name));
    db.components[d.name] = comp;
  }

  // 2. Components only documented (hardware drivers, kinematics): build from
  //    man9 (+ .comp if any). Pins are best-effort from man9 member docs.
  for (const m of input.man9) {
    if (handled.has(m.name)) continue;
    const comp: ComponentDef = {
      name: m.name,
      sources: ['man9'],
      pins: [],
      params: [],
      functions: [],
      modparams: [],
      instanceNaming: inferNaming(m.name, false),
    };
    enrichWithComp(comp, compByName.get(m.name));
    enrichWithMan9(comp, m);
    db.components[m.name] = comp;
    handled.add(m.name);
  }

  // 3. .comp files with neither a dump nor a man9 page (rare custom docs).
  for (const c of input.comps) {
    if (handled.has(c.name)) continue;
    const comp: ComponentDef = {
      name: c.name,
      sources: ['comp'],
      pins: c.pins.map((p) => ({ name: p.halname, type: p.type, dir: p.dir, doc: p.doc })),
      params: c.params.map((p) => ({ name: p.halname, type: p.type, dir: p.dir, doc: p.doc })),
      functions: c.functions.map((f) => ({ name: f.name, doc: f.doc })),
      modparams: c.modparams.map((mp) => ({ name: mp.name, doc: mp.doc, default: mp.default })),
      instanceNaming: inferNaming(c.name, false),
    };
    enrichWithComp(comp, c);
    db.components[c.name] = comp;
    handled.add(c.name);
  }

  db.iniSections = input.iniSections;
  db.iniRuntimeConsumedKeys = input.consumedKeys;
  db.homingKeys = input.homingKeys;
  db.commands = input.commands ?? {};
  db.gcodeWords = input.gcodeWords ?? {};
  return db;
}

function enrichWithComp(comp: ComponentDef, parsed: ParsedComp | undefined): void {
  if (!parsed) return;
  if (!comp.sources.includes('comp')) comp.sources.push('comp');
  comp.description = parsed.description ?? comp.description;
  comp.author = parsed.author;
  comp.license = parsed.license;
  comp.seeAlso = parsed.seeAlso;
  comp.notes = parsed.notes;
  comp.examples = parsed.examples;
  if (parsed.modparams.length) {
    comp.modparams = parsed.modparams.map((mp) => ({ name: mp.name, doc: mp.doc, default: mp.default }));
  }
  // Attach pin/param doc strings by matching the .comp halname to the suffix.
  const pinDoc = new Map(parsed.pins.map((p) => [p.halname, p.doc]));
  for (const p of comp.pins) if (!p.doc && pinDoc.get(p.name)) p.doc = pinDoc.get(p.name);
  const paramDoc = new Map(parsed.params.map((p) => [p.halname, p.doc]));
  for (const p of comp.params) if (!p.doc && paramDoc.get(p.name)) p.doc = paramDoc.get(p.name);
  const fnDoc = new Map(parsed.functions.map((f) => [f.name, f.doc]));
  for (const f of comp.functions) if (!f.doc && fnDoc.get(f.name)) f.doc = fnDoc.get(f.name);
}

function enrichWithMan9(comp: ComponentDef, man9: ParsedMan9 | undefined): void {
  if (!man9) return;
  if (!comp.sources.includes('man9')) comp.sources.push('man9');
  if (!comp.description) comp.description = man9.summary;
  if (!comp.descriptionMd) comp.descriptionMd = man9.descriptionMd;
  comp.manSection = 9;
  // Attach pin docs from man9 member docs (best effort).
  const absolute = !!comp.absolute;
  const docBySuffix = new Map<string, string>();
  for (const [key, doc] of Object.entries(man9.memberDocs)) {
    docBySuffix.set(man9KeyToSuffix(key, comp.name, absolute), doc);
  }
  const apply = (arr: (PinDef | ParamDef)[]): void => {
    for (const p of arr) {
      if (!p.doc && docBySuffix.get(p.name)) p.doc = docBySuffix.get(p.name);
    }
  };
  apply(comp.pins);
  apply(comp.params);
}
