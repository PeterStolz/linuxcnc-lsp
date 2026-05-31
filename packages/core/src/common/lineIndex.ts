import type { Position, Range } from 'vscode-languageserver-types';

/**
 * Maps between absolute character offsets and {line, character} positions for a
 * single text document. Built once per document; conversions are O(log n).
 */
export class LineIndex {
  /** Offset of the first character of each line. lineStarts[0] === 0. */
  private readonly lineStarts: number[];
  readonly length: number;

  constructor(public readonly text: string) {
    this.length = text.length;
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // A line begins after an LF, or after a bare CR not part of a CRLF pair.
      if (c === 10 /* \n */) starts.push(i + 1);
      else if (c === 13 /* \r */ && text.charCodeAt(i + 1) !== 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.length));
    // Binary search for the greatest lineStart <= clamped.
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: clamped - this.lineStarts[lo] };
  }

  offsetAt(position: Position): number {
    if (position.line < 0) return 0;
    if (position.line >= this.lineStarts.length) return this.length;
    const lineStart = this.lineStarts[position.line];
    const lineEnd =
      position.line + 1 < this.lineStarts.length
        ? this.lineStarts[position.line + 1]
        : this.length;
    return Math.min(lineStart + Math.max(0, position.character), lineEnd);
  }

  rangeAt(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }

  /** The text of a given 0-based line, without its trailing newline. */
  lineText(line: number): string {
    if (line < 0 || line >= this.lineStarts.length) return '';
    const start = this.lineStarts[line];
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.length;
    return this.text.slice(start, end).replace(/\r\n$|[\r\n]$/, '');
  }
}
