import { TextEdit } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { GcodeProgram } from './ast';

export interface GcodeFormatOptions {
  tabSize: number;
  insertSpaces: boolean;
  /** Remove trailing whitespace (and empty out whitespace-only lines). Mirrors
   *  the LSP `FormattingOptions.trimTrailingWhitespace`, which VS Code derives
   *  from the standard `files.trimTrailingWhitespace` setting (default `false`).
   *  Left `false`/undefined — the default — the formatter rewrites leading
   *  indentation only and preserves every other byte, so it never trims trailing
   *  whitespace the user did not ask the editor to trim, and a run over an
   *  already-correctly-indented file is a no-op that leaves git history clean. */
  trimTrailingWhitespace?: boolean;
}

/** Re-indent a G-code document so O-word blocks (sub / if / while / do / repeat)
 *  nest by one level. The formatter OWNS only the leading indentation: it
 *  rewrites a line's leading whitespace to its nesting depth and otherwise leaves
 *  the line byte-for-byte. Trailing whitespace — including whitespace-only lines,
 *  which carry no token to indent — is touched only when `trimTrailingWhitespace`
 *  is set, matching VS Code's `files.trimTrailingWhitespace`. Idempotent in both
 *  modes. Returns minimal per-line edits (only changed lines). */
export function formatGcode(
  lineIndex: LineIndex, program: GcodeProgram, opts: GcodeFormatOptions,
): TextEdit[] {
  const unit = opts.insertSpaces ? ' '.repeat(Math.max(1, opts.tabSize || 2)) : '\t';
  const trimTrailing = opts.trimTrailingWhitespace ?? false;
  const edits: TextEdit[] = [];
  const lineStarts = buildLineStarts(lineIndex);

  const text = lineIndex.text;
  for (let line = 0; line < lineIndex.lineCount; line++) {
    const raw = lineIndex.lineText(line); // excludes the trailing newline
    const start = lineStarts[line];
    // Split the line into leading whitespace | content | trailing whitespace.
    // `raw` is newline-free (LineIndex strips it), so [ \t] captures all of it.
    const contentStart = raw.length - raw.replace(/^[ \t]+/, '').length;
    const contentEnd = raw.replace(/[ \t]+$/, '').length;
    const content = raw.slice(contentStart, contentEnd);

    let desired: string;
    if (content === '') {
      // Whitespace-only (or empty) line: no token to indent. Trim to empty only if
      // asked AND it won't fuse line breaks: if this line sits between a bare CR
      // (the previous line's terminator) and its own LF, deleting its whitespace
      // joins them into one CRLF and silently drops a line — so leave it untouched.
      const fusesBreaks = text.charCodeAt(start - 1) === 13 && text.charCodeAt(start + raw.length) === 10;
      desired = trimTrailing && !fusesBreaks ? '' : raw;
    } else {
      const indent = unit.repeat(program.lineDepth[line] ?? 0);
      const trailing = trimTrailing ? '' : raw.slice(contentEnd);
      desired = indent + content + trailing;
    }
    if (desired === raw) continue;
    edits.push(TextEdit.replace(lineIndex.rangeAt(start, start + raw.length), desired));
  }
  return edits;
}

/** Offset of the first character of each line (LineIndex keeps this private). */
function buildLineStarts(lineIndex: LineIndex): number[] {
  const starts = new Array<number>(lineIndex.lineCount);
  for (let line = 0; line < lineIndex.lineCount; line++) {
    starts[line] = lineIndex.offsetAt({ line, character: 0 });
  }
  return starts;
}
