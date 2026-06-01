import { describe, it, expect } from 'vitest';
import { TextEdit, FormattingOptions } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import { LineIndex } from '@linuxcnc/core';
import { buildDocModelFromText, computeFormat } from '../src/analysis';

/**
 * Integration coverage one layer above the pure formatter: it exercises the real
 * server path — `.ngc` kind detection in buildDocModelFromText, then computeFormat
 * — with the exact GcodeFormatOptions the server derives from an LSP
 * FormattingOptions payload. This is the closest we get to the format request
 * without launching VS Code (that round-trip is covered by the e2e suite).
 */

function apply(text: string, edits: TextEdit[]): string {
  const li = new LineIndex(text);
  const off = edits
    .map((e) => ({ s: li.offsetAt(e.range.start), e: li.offsetAt(e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s);
  let out = text;
  for (const ed of off) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
  return out;
}

/** Mirror exactly what server `onDocumentFormatting` does with params.options. */
function formatLikeServer(text: string, options: FormattingOptions): string {
  const model = buildDocModelFromText(URI.file('/tmp/macro.ngc').toString(), text);
  const edits = computeFormat(model, {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
    trimTrailingWhitespace: options.trimTrailingWhitespace ?? false,
  });
  return apply(text, edits);
}

describe('server format path — .ngc routing + FormattingOptions', () => {
  const src = 'o<p> sub\nG1 X1  \n   \no<p> endsub\n';

  it('routes .ngc to the G-code formatter and indents', () => {
    expect(formatLikeServer(src, { tabSize: 2, insertSpaces: true }))
      .toBe('o<p> sub\n  G1 X1  \n   \no<p> endsub\n');
  });

  it('preserves trailing/blank whitespace when the option is absent (VS Code default)', () => {
    // trimTrailingWhitespace omitted entirely — the real payload when the user
    // has files.trimTrailingWhitespace off (its default).
    const out = formatLikeServer(src, { tabSize: 2, insertSpaces: true });
    expect(out).toContain('G1 X1  \n');
    expect(out).toContain('   \n');
  });

  it('trims when the client sends trimTrailingWhitespace:true', () => {
    expect(formatLikeServer(src, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true }))
      .toBe('o<p> sub\n  G1 X1\n\no<p> endsub\n');
  });

  it('treats trimTrailingWhitespace:false the same as absent', () => {
    const a = formatLikeServer(src, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: false });
    const b = formatLikeServer(src, { tabSize: 2, insertSpaces: true });
    expect(a).toBe(b);
  });

  it('honors tabSize/insertSpaces from the payload', () => {
    expect(formatLikeServer(src, { tabSize: 4, insertSpaces: false }))
      .toBe('o<p> sub\n\tG1 X1  \n   \no<p> endsub\n');
  });
});
