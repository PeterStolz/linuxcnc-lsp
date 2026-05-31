import { describe, it, expect } from 'vitest';
import { DocumentHighlightKind } from 'vscode-languageserver-types';
import {
  parseGcode, LineIndex,
  gcodeDefinition, gcodeReferences, gcodeDocumentHighlights,
  gcodeDocumentSymbols, gcodeFoldingRanges,
} from '../src/index';

const SRC = 'o<p> sub\nG1 X1\no<p> endsub\no<p> call\n';
const li = new LineIndex(SRC);
const prog = parseGcode(SRC);
const at = (needle: string): number => SRC.indexOf(needle) + 1; // land inside the O-word

describe('gcode in-file navigation', () => {
  it('go-to-definition jumps from a call to the sub definition', () => {
    const defs = gcodeDefinition(prog, li, 'file:///a.ngc', at('o<p> call'));
    expect(defs).toHaveLength(1);
    expect(defs[0].range.start.line).toBe(0); // the `o<p> sub` line
  });

  it('returns nothing for a call with no definition', () => {
    const s = 'o<x> call\n';
    expect(gcodeDefinition(parseGcode(s), new LineIndex(s), 'file:///a.ngc', 1)).toEqual([]);
  });

  it('find-references returns sub + endsub + call', () => {
    const refs = gcodeReferences(prog, li, 'file:///a.ngc', at('o<p> call'), true);
    expect(refs).toHaveLength(3);
  });

  it('find-references can exclude the declaration', () => {
    const refs = gcodeReferences(prog, li, 'file:///a.ngc', at('o<p> call'), false);
    expect(refs).toHaveLength(2);
  });

  it('document highlights mark the def as a write and others as reads', () => {
    const hl = gcodeDocumentHighlights(prog, li, at('o<p> call'));
    expect(hl).toHaveLength(3);
    expect(hl.filter((h) => h.kind === DocumentHighlightKind.Write)).toHaveLength(1);
  });

  it('document symbols outline each subroutine', () => {
    const syms = gcodeDocumentSymbols(prog, li);
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('o<p>');
    expect(syms[0].kind).toBe(12 /* SymbolKind.Function */);
  });

  it('folding ranges cover the subroutine block', () => {
    const folds = gcodeFoldingRanges(prog, li);
    expect(folds.some((f) => f.startLine === 0 && f.endLine === 2)).toBe(true);
  });

  it('folds a run of comment lines', () => {
    const s = '; a\n; b\n; c\nG0 X1\n';
    const folds = gcodeFoldingRanges(parseGcode(s), new LineIndex(s));
    expect(folds.some((f) => f.startLine === 0 && f.endLine === 2)).toBe(true);
  });
});
