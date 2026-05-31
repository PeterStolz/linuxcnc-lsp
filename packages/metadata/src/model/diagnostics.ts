import { Diagnostic } from 'vscode-languageserver-types';
import {
  collectIniRefs, findSection, findEntries, HalToken, SetpStatement,
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

  // --- INI value type / enum validation ---
  for (const ini of model.ini ? [model.ini, ...model.iniIncludes] : []) {
    for (const section of ini.ini.sections) {
      for (const entry of section.entries) {
        if (!entry.value) continue;
        const def = index.iniKey(section.name.text, entry.key.text);
        if (!def?.type) continue;
        const problem = validateIniValue(def.type, entry.value.text, def.doc);
        if (problem) {
          sinkFor(ini.uri).add(problem.rule, ini.lineIndex.rangeAt(entry.value.start, entry.value.end), problem.message);
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

  // --- setp on a read-only target (output pin or read-only parameter) ---
  // halcmd rejects this at runtime. Only flag when the target resolves
  // confidently to an `out` pin or `ro` param; unresolved/Mesa pins are skipped.
  for (const f of model.files) {
    for (const stmt of f.hal.statements) {
      if (stmt.kind !== 'setp') continue;
      const pin = (stmt as SetpStatement).pinToken;
      if (!pin || pin.ini) continue;
      const name = model.aliases.get(pin.text) ?? pin.text;
      let problem: string | undefined;
      const builtin = index.builtinPin(name);
      if (builtin) {
        if (builtin.pin.dir === 'out') problem = `Cannot 'setp' '${pin.text}': it is an output pin (read-only).`;
      } else {
        const r = resolveInstance(name, model.instances);
        if (r) {
          const p = index.pin(r.comp, r.suffix);
          if (p) {
            if (p.dir === 'out') problem = `Cannot 'setp' '${pin.text}': it is an output pin (read-only).`;
          } else {
            const pa = index.param(r.comp, r.suffix);
            if (pa && pa.dir === 'ro') problem = `Cannot 'setp' '${pin.text}': it is a read-only (R) parameter.`;
          }
        }
      }
      if (problem) sinkFor(f.uri).add('hal.param.readonlyParamSet', f.lineIndex.rangeAt(pin.start, pin.end), problem);
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

type ValueProblem = { rule: 'ini.value.typeMismatch' | 'ini.value.enumMismatch'; message: string } | undefined;

/** Validate an INI value against its documented type. Conservative: only judges
 *  unambiguous types (numbers, booleans, and enums with a clearly-enumerated
 *  allowed set), and never judges values that contain INI/HAL substitution or
 *  span multiple whitespace-separated tokens. */
function validateIniValue(type: string, value: string, doc?: string): ValueProblem {
  const v = value.trim();
  if (!v) return undefined;
  if (/[[\]$]/.test(v)) return undefined; // contains a substitution — don't judge
  const t = type.toLowerCase();
  const numeric = (re: RegExp, label: string): ValueProblem =>
    re.test(v) ? undefined : { rule: 'ini.value.typeMismatch', message: `Expected ${label} for this key, but got \`${v}\`.` };

  switch (t) {
    case 'real':
    case 'float':
    case 'number':
      return numeric(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, 'a real number');
    case 'int':
    case 's32':
    case 's64':
      // decimal, or hex/octal/binary (LinuxCNC strtol base-0 accepts 0x/0X,
      // 0o/0O, 0b/0B for integer keys).
      return numeric(/^[+-]?(\d+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/, 'an integer');
    case 'u32':
    case 'u64':
      return numeric(/^\+?(\d+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/, 'a non-negative integer');
    case 'bit':
      return /^[01]$/.test(v) ? undefined : { rule: 'ini.value.typeMismatch', message: `Expected 0 or 1 for this key, but got \`${v}\`.` };
    case 'bool':
      return /^(0|1|true|false|yes|no)$/i.test(v)
        ? undefined
        : { rule: 'ini.value.typeMismatch', message: `Expected a boolean (1/0, TRUE/FALSE or YES/NO), but got \`${v}\`.` };
    case 'enum': {
      const allowed = enumValues(doc);
      if (!allowed.length) return undefined;
      if (allowed.some((a) => a.toLowerCase() === v.toLowerCase())) return undefined;
      return { rule: 'ini.value.enumMismatch', message: `Expected one of ${allowed.map((a) => `\`${a}\``).join(', ')}, but got \`${v}\`.` };
    }
    default:
      return undefined;
  }
}

/** Extract an enum's allowed values from its doc, but only when the prose
 *  clearly enumerates them (avoids treating incidental backticked words as the
 *  allowed set). */
function enumValues(doc?: string): string[] {
  if (!doc || !/\beither\b|\bone of\b|\bor `/i.test(doc)) return [];
  const out: string[] = [];
  const re = /`([A-Za-z][A-Za-z0-9_]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) out.push(m[1]);
  return [...new Set(out)];
}

// Re-export for callers needing instance resolution alongside diagnostics.
export { resolveInstance };
