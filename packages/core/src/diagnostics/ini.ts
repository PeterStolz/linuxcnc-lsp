import { LineIndex } from '../common/lineIndex';
import { IniFile } from '../ini/ast';
import { DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, Diagnostic } from './types';

/** INI keys that legitimately appear multiple times in one section (each
 *  occurrence adds an entry, so a "duplicate" is intentional and not first-wins).
 *
 *  This set is verified against LinuxCNC's reader code: a key is repeatable iff
 *  it is read via an indexed C++ loop (`while findString(n, KEY, SEC)`), the
 *  shell `inivar -num` loop in scripts/linuxcnc.in, or Python
 *  `linuxcnc.ini.findall(SEC, KEY)`. Keys read once (plain `findString`,
 *  `iniFind*`, `.find`) are single-valued and intentionally NOT listed here.
 *  Reader sites are noted per key. The authoritative, section-scoped set will
 *  come from the INI schema in the metadata phase; key-only matching is safe
 *  for now because every repeatable key name is repeatable in all of its
 *  sections (e.g. MACRO in [MACROS]/[DISPLAY]/[TOUCHY], MDI_COMMAND in
 *  [HALUI]/[MDI_COMMAND_LIST]). */
const REPEATABLE_KEYS = new Set([
  'halfile',            // scripts/linuxcnc.in (inivar -num); update_ini.py findall
  'halcmd',             // scripts/linuxcnc.in (inivar -num)
  'postgui_halfile',    // axis.py/getiniinfo.py/iniinfo.py findall
  'postgui_halcmd',     // axis.py/getiniinfo.py/iniinfo.py findall
  'app',                // scripts/linuxcnc.in (inivar -num, [APPLICATIONS])
  'remap',              // rs274ngc_pre.cc:1041 (while findString(n,"REMAP","RS274NGC"))
  'macro',              // touchy.py/getiniinfo.py/iniinfo.py findall
  'mdi_command',        // halui.cc:1487 indexed loop; iniinfo.py findall
  'program_extension',  // axis.py/gmoccapy/iniinfo.py findall ([FILTER])
  'ngcgui_subfile',     // iniinfo.py/pyngcgui.py findall ([DISPLAY])
  'tkpkg',              // axis.py findall ([DISPLAY])
  'tkapp',              // axis.py findall ([DISPLAY])
  'embed_tab_name',     // touchy/gscreen/getiniinfo/iniinfo findall
  'embed_tab_command',  // touchy/gscreen/getiniinfo/iniinfo findall
  'embed_tab_location', // gscreen/getiniinfo/iniinfo findall
  'message_text',       // gscreen.py/iniinfo.py findall ([DISPLAY] user-message widget)
  'message_type',       // gscreen.py/iniinfo.py findall
  'message_pinname',    // gscreen.py/iniinfo.py findall
  'message_boldtext',   // gscreen.py/iniinfo.py findall
  'message_details',    // iniinfo.py findall
  'message_icon',       // iniinfo.py findall
  'path_append',        // python_plugin.cc:419 indexed loop ([PYTHON])
  'path_prepend',       // python_plugin.cc:400 indexed loop ([PYTHON])
  'button',             // xhc-hb04.cc:680 indexed loop (pendant config sections)
]);

/** Section-scoped repeatable keys, as `${section}|${key}` (both lowercased).
 *  Used when a key is repeatable only inside one specific section and the key
 *  name is too generic to allowlist globally (a plain `plugin` entry would
 *  mask genuine single-valued PLUGIN duplicates elsewhere). Unlike the set
 *  above, these cannot be verified against an in-tree reader. */
const REPEATABLE_SECTION_KEYS = new Set([
  // Smithy's EZTROL GUI loads each PLUGIN line; its reader is proprietary and
  // not in the LinuxCNC tree, so this is inferred from shipped configs (e.g.
  // by_machine/smithy/*.ini load wizard + webwizard plugins).
  'eztrol|plugin',
]);

/** True if a key is repeatable in the given section. Covers the global set,
 *  the dynamic [DISPLAY] multi-message family (MULTIMESSAGE_ID and
 *  MULTIMESSAGE_<id>_TEXT/TYPE/... where <id> is user-chosen, read via findall
 *  in iniinfo.py:439-455), and the section-scoped exceptions above. Both
 *  arguments must already be lowercased. */
function isRepeatableKey(lc: string, sectionLc: string): boolean {
  return (
    REPEATABLE_KEYS.has(lc) ||
    lc.startsWith('multimessage_') ||
    REPEATABLE_SECTION_KEYS.has(`${sectionLc}|${lc}`)
  );
}

/** Intra-file diagnostics for an INI document. */
export function diagnoseIniIntraFile(
  text: string,
  file: IniFile,
  lineIndex: LineIndex,
  opts: DiagnosticSinkOptions = {},
): Diagnostic[] {
  const suppressions = opts.suppressions ?? new SuppressionIndex(text, lineIndex);
  const sink = new DiagnosticSink({ ...opts, suppressions });

  // QtVCP/panelui configs use configobj nested sections ([[...]]) and reuse the
  // .ini extension, but they are NOT LinuxCNC machine INIs. Skip structural
  // diagnostics for them. Detect via parsed SECTION HEADERS (the parser reads a
  // `[[nested]]` header as a section whose name starts with `[`) rather than a
  // raw-text regex — a value-continuation line that merely starts with `[[`
  // must not suppress diagnostics for the whole file.
  if (file.sections.some((s) => s.name.text.startsWith('['))) return [];

  // Syntax problems surfaced by the parser.
  for (const p of file.problems) {
    sink.add(p.code, lineIndex.rangeAt(p.start, p.end), p.message);
  }

  // Duplicate non-repeatable keys within a section. LinuxCNC uses the first
  // occurrence and silently ignores the rest, so any repeat is reported:
  //  - different value  -> ini.syntax.duplicateKey  (a value is silently dead)
  //  - same value       -> ini.syntax.redundantKey  (harmless but redundant)
  for (const section of file.sections) {
    const sectionLc = section.name.text.toLowerCase();
    const firstValue = new Map<string, string>();
    for (const entry of section.entries) {
      const lc = entry.key.text.toLowerCase();
      if (isRepeatableKey(lc, sectionLc)) continue;
      const value = entry.value?.text ?? '';
      if (!firstValue.has(lc)) {
        firstValue.set(lc, value);
        continue;
      }
      const first = firstValue.get(lc)!;
      const range = lineIndex.rangeAt(entry.key.start, entry.key.end);
      if (first !== value) {
        sink.add(
          'ini.syntax.duplicateKey',
          range,
          `Duplicate key '${entry.key.text}' in [${section.name.text}] with a different value; LinuxCNC uses the first ('${first}').`,
        );
      } else {
        sink.add(
          'ini.syntax.redundantKey',
          range,
          `Redundant duplicate key '${entry.key.text}' in [${section.name.text}] (same value '${value}'); LinuxCNC uses the first occurrence.`,
        );
      }
    }
  }

  return sink.items;
}
