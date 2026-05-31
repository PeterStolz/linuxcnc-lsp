import { LineIndex } from '../common/lineIndex';
import { IniFile } from '../ini/ast';
import { DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, Diagnostic } from './types';

/** INI keys that may legitimately appear multiple times in one section. */
const REPEATABLE_KEYS = new Set([
  'halfile',
  'halcmd',
  'program_extension',
  'app',
  'mdi_command',
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

  // Syntax problems surfaced by the parser.
  for (const p of file.problems) {
    sink.add(p.code, lineIndex.rangeAt(p.start, p.end), p.message);
  }

  // Duplicate non-repeatable keys within a section.
  for (const section of file.sections) {
    const seen = new Map<string, number>();
    for (const entry of section.entries) {
      const lc = entry.key.text.toLowerCase();
      if (REPEATABLE_KEYS.has(lc)) continue;
      const count = (seen.get(lc) ?? 0) + 1;
      seen.set(lc, count);
      if (count > 1) {
        sink.add(
          'ini.syntax.duplicateKey',
          lineIndex.rangeAt(entry.key.start, entry.key.end),
          `Duplicate key '${entry.key.text}' in [${section.name.text}]; the first value is used.`,
        );
      }
    }
  }

  return sink.items;
}
