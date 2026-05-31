import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { IniFile } from '../ini/ast';

/** Fold runs of >=2 consecutive comment lines in a HAL document. */
export function halFoldingRanges(lineIndex: LineIndex): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const isComment = (l: number) => /^\s*#/.test(lineIndex.lineText(l));
  let runStart = -1;
  for (let line = 0; line < lineIndex.lineCount; line++) {
    if (isComment(line)) {
      if (runStart === -1) runStart = line;
    } else {
      if (runStart !== -1 && line - 1 > runStart) {
        ranges.push({ startLine: runStart, endLine: line - 1, kind: FoldingRangeKind.Comment });
      }
      runStart = -1;
    }
  }
  if (runStart !== -1 && lineIndex.lineCount - 1 > runStart) {
    ranges.push({ startLine: runStart, endLine: lineIndex.lineCount - 1, kind: FoldingRangeKind.Comment });
  }
  return ranges;
}

/** Fold each [SECTION] from its header to the last line of the section. */
export function iniFoldingRanges(file: IniFile, lineIndex: LineIndex): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const section of file.sections) {
    const startLine = lineIndex.positionAt(section.headerStart).line;
    const endLine = lineIndex.positionAt(Math.max(section.end - 1, section.headerStart)).line;
    if (endLine > startLine) {
      ranges.push({ startLine, endLine, kind: FoldingRangeKind.Region });
    }
  }
  return ranges;
}
