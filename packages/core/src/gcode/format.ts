import { TextEdit } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { GcodeProgram } from './ast';

export interface GcodeFormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

/** Re-indent a G-code document so O-word blocks (sub / if / while / do / repeat)
 *  nest by one level, and trim trailing whitespace. Indentation-only: nothing on
 *  a line is rewritten except its leading/trailing whitespace, so the transform
 *  is safe and idempotent. Returns minimal per-line edits (only changed lines). */
export function formatGcode(
  lineIndex: LineIndex, program: GcodeProgram, opts: GcodeFormatOptions,
): TextEdit[] {
  const unit = opts.insertSpaces ? ' '.repeat(Math.max(1, opts.tabSize || 2)) : '\t';
  const edits: TextEdit[] = [];
  const lineStarts = buildLineStarts(lineIndex);

  for (let line = 0; line < lineIndex.lineCount; line++) {
    const raw = lineIndex.lineText(line); // excludes the trailing newline
    const inner = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    const desired = inner === '' ? '' : unit.repeat(program.lineDepth[line] ?? 0) + inner;
    if (desired === raw) continue;
    const start = lineStarts[line];
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
