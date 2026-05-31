import { LineIndex } from '../common/lineIndex';
import { IniFile } from '../ini/ast';
import { DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, Diagnostic } from './types';

/** INI keys that legitimately appear multiple times in one section (each
 *  occurrence adds an entry). The authoritative set will come from the INI
 *  schema in the metadata phase; this list covers the common list-valued keys
 *  so the duplicate-key hint does not fire on known-good configs. */
const REPEATABLE_KEYS = new Set([
  'halfile',
  'halcmd',
  'program_extension',
  'app',
  'mdi_command',
  'ngcgui_subfile',
  'tkpkg',
  'embed_tab_name',
  'embed_tab_command',
  'embed_tab_location',
  'user_command',
  'user_m_path',
  'subroutine_path',
]);

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
  // diagnostics for them rather than flagging valid configobj syntax.
  if (/^\s*\[\[/m.test(text)) return [];

  // Syntax problems surfaced by the parser.
  for (const p of file.problems) {
    sink.add(p.code, lineIndex.rangeAt(p.start, p.end), p.message);
  }

  // Duplicate non-repeatable keys with CONFLICTING values within a section.
  // (A duplicate with the same value is harmless; LinuxCNC uses the first.)
  for (const section of file.sections) {
    const firstValue = new Map<string, string>();
    for (const entry of section.entries) {
      const lc = entry.key.text.toLowerCase();
      if (REPEATABLE_KEYS.has(lc)) continue;
      const value = entry.value?.text ?? '';
      if (!firstValue.has(lc)) {
        firstValue.set(lc, value);
        continue;
      }
      if (firstValue.get(lc) !== value) {
        sink.add(
          'ini.syntax.duplicateKey',
          lineIndex.rangeAt(entry.key.start, entry.key.end),
          `Duplicate key '${entry.key.text}' in [${section.name.text}] with a different value; LinuxCNC uses the first ('${firstValue.get(lc)}').`,
        );
      }
    }
  }

  return sink.items;
}
