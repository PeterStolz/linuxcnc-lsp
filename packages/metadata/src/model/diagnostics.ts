import { Diagnostic } from 'vscode-languageserver-types';
import {
  collectIniRefs, findSection, findEntries, HalToken,
  DiagnosticSink, SuppressionIndex, SeverityName,
} from '@linuxcnc/core';
import { MetadataIndex } from '../db';
import { MachineModel } from './types';
import { resolveInstance } from './build';

export interface CrossFileOptions {
  overrides?: Record<string, SeverityName>;
}

/** Cross-file diagnostics for a machine: INI-ref resolution + signal graph. */
export function crossFileDiagnostics(
  model: MachineModel,
  index: MetadataIndex,
  opts: CrossFileOptions = {},
): Map<string, Diagnostic[]> {
  const byUri = new Map<string, { sink: DiagnosticSink }>();
  const sinkFor = (uri: string): DiagnosticSink => {
    let e = byUri.get(uri);
    if (!e) {
      const file = model.files.find((f) => f.uri === uri);
      const suppressions = file ? new SuppressionIndex(file.text, file.lineIndex) : undefined;
      e = { sink: new DiagnosticSink({ overrides: opts.overrides, suppressions }) };
      byUri.set(uri, e);
    }
    return e.sink;
  };

  // --- INI constant references in HAL ([SECTION]KEY) ---
  // Resolve presence across the main INI AND any #INCLUDE-d files.
  if (model.ini) {
    const iniFiles = [model.ini, ...model.iniIncludes];
    const sectionPresent = (section: string) => iniFiles.some((f) => findSection(f.ini, section));
    const keyPresent = (section: string, key: string) =>
      iniFiles.some((f) => {
        const sec = findSection(f.ini, section);
        return sec ? findEntries(sec, key).length > 0 : false;
      });
    for (const f of model.files) {
      for (const stmt of f.hal.statements) {
        for (const ref of collectIniRefs(stmt)) {
          const { section, key } = ref.ini!;
          const r = f.lineIndex.rangeAt(ref.start, ref.end);
          if (!sectionPresent(section)) {
            sinkFor(f.uri).add('hal.iniref.sectionMissing', r,
              `INI section [${section}] is not defined in ${baseName(model.iniUri)}`);
          } else if (!keyPresent(section, key)) {
            sinkFor(f.uri).add('hal.iniref.keyMissing', r,
              `INI variable [${section}]${key} is not defined in ${baseName(model.iniUri)}`);
          }
        }
      }
    }
  }

  // --- Unknown component on loadrt ---
  for (const f of model.files) {
    for (const stmt of f.hal.statements) {
      if (stmt.kind !== 'loadrt') continue;
      const comp = (stmt as { componentToken?: HalToken }).componentToken;
      if (!comp || comp.ini) continue;
      if (!index.hasComponentName(comp.text)) {
        sinkFor(f.uri).add('hal.comp.unknownComponent',
          f.lineIndex.rangeAt(comp.start, comp.end),
          `Unknown HAL component '${comp.text}' (not in the bundled metadata or workspace .comp files)`);
      }
    }
  }

  // --- Signal graph rules ---
  for (const [name, node] of model.signals) {
    const def = node.firstDef ?? node.occurrences[0];
    if (!def) continue;
    const writers = node.writers;
    const hasSet = (node.setBy?.length ?? 0) > 0;

    // Multiple DISTINCT output pins driving one signal — HAL rejects this at
    // runtime. Only count writers whose direction is RESOLVED as out (never
    // arrow-guessed, which is unreliable), and dedupe by pin name (the same
    // source pin re-stated across net lines is not an error).
    const resolvedWriters = writers.filter((w) => w.resolved);
    const distinctWriters = [...new Set(resolvedWriters.map((w) => w.fullName))];
    if (distinctWriters.length > 1) {
      const firstName = distinctWriters[0];
      for (const w of resolvedWriters) {
        if (w.fullName === firstName) continue;
        sinkFor(w.loc.uri).add('hal.signal.multipleWriters', w.loc.range,
          `Signal '${name}' is driven by multiple output pins (also '${firstName}'); HAL allows only one.`);
      }
    }

    // no-writer / no-reader require a COMPLETE picture: suppress when the
    // machine has opaque (Tcl/LIB:) files or the signal links any pin whose
    // direction we could not resolve (e.g. Mesa hm2 pins, GUI pins).
    if (!model.hasOpaqueFiles && !node.hasUnresolved) {
      if (writers.length === 0 && !hasSet && node.readers.length > 0) {
        sinkFor(def.uri).add('hal.signal.noWriter', def.range,
          `Signal '${name}' has readers but no writer.`);
      }
      if (writers.length > 0 && node.readers.length === 0 && !hasSet) {
        sinkFor(def.uri).add('hal.signal.noReader', def.range,
          `Signal '${name}' is written but never read.`);
      }
    }

    // Type conflict among linked pins.
    const types = new Set(
      [...writers, ...node.readers].map((p) => p.type).filter((t): t is string => !!t),
    );
    if (types.size > 1) {
      sinkFor(def.uri).add('hal.signal.typeConflict', def.range,
        `Signal '${name}' links pins of differing types: ${[...types].join(', ')}.`);
    }
  }

  const result = new Map<string, Diagnostic[]>();
  for (const [uri, e] of byUri) result.set(uri, e.sink.items);
  // Ensure every file gets an (at least empty) entry so stale diagnostics clear.
  for (const f of model.files) if (!result.has(f.uri)) result.set(f.uri, []);
  return result;
}

function baseName(uri?: string): string {
  if (!uri) return 'the INI';
  const m = /[^/\\]+$/.exec(uri);
  return m ? m[0] : uri;
}

// Re-export for callers needing instance resolution alongside diagnostics.
export { resolveInstance };
