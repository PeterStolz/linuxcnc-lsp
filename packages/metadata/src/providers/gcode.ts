import {
  Hover, MarkupKind, Range, CompletionItem, CompletionItemKind, TextEdit,
} from 'vscode-languageserver-types';
import { LineIndex, tokenizeGcode, gcodeTokenAt, GcodeToken, GcodeTokenKind, O_KEYWORDS } from '@linuxcnc/core';
import { MetadataIndex } from '../db';

function md(value: string, range?: Range): Hover {
  return { contents: { kind: MarkupKind.Markdown, value }, range };
}

// --- Builtin knowledge (not in the doc DB) ---------------------------------

/** Address letters whose meaning is positional (no per-code doc). */
const LETTER_DOC: Record<string, string> = {
  X: 'X axis coordinate', Y: 'Y axis coordinate', Z: 'Z axis coordinate',
  A: 'A rotary axis coordinate', B: 'B rotary axis coordinate', C: 'C rotary axis coordinate',
  U: 'U axis coordinate (additional linear)', V: 'V axis coordinate (additional linear)', W: 'W axis coordinate (additional linear)',
  I: 'arc center offset along X (center-format arc)', J: 'arc center offset along Y', K: 'arc center offset along Z (or thread pitch for G33)',
  R: 'arc radius (radius-format arc) / cycle retract plane',
  P: 'parameter: dwell time, subroutine arg, or coordinate-system number',
  Q: 'parameter: peck increment / feed-per-rev / loop count',
  L: 'parameter: G10 mode / canned-cycle repeat count',
  D: 'tool diameter or cutter-compensation slot',
  H: 'tool length offset index (G43)',
  E: 'parameter (probing / general)',
  N: 'line number',
};

const O_KEYWORD_DOC: Record<string, string> = {
  sub: 'begin a subroutine block: `O<name> sub` … `O<name> endsub`',
  endsub: 'end a subroutine block (optionally `endsub [return-value]`)',
  call: 'call a subroutine: `O<name> call [arg1] [arg2] …` (args become `#1`, `#2`, …)',
  return: 'return early from a subroutine (optionally with a value)',
  if: 'conditional: `O<n> if [cond]` … `O<n> endif`',
  elseif: 'additional condition in an if-block',
  else: 'alternative branch of an if-block',
  endif: 'end an if-block',
  while: 'top-testing loop: `O<n> while [cond]` … `O<n> endwhile`',
  endwhile: 'end a while-loop',
  do: 'bottom-testing loop: `O<n> do` … `O<n> while [cond]`',
  repeat: 'repeat a block a fixed number of times: `O<n> repeat [count]` … `O<n> endrepeat`',
  endrepeat: 'end a repeat-block',
  break: 'exit the enclosing while/do loop',
  continue: 'skip to the next iteration of the enclosing loop',
};

/** Well-known numbered-parameter ranges. */
function numberedParamDoc(num: number): string {
  if (num >= 5161 && num <= 5169) return 'G28 home position (axes X Y Z A B C U V W)';
  if (num >= 5181 && num <= 5189) return 'G30 home position';
  if (num >= 5210 && num <= 5219) return 'G92 offset (and enable flag at 5210)';
  if (num === 5220) return 'current coordinate system number (1 = G54 … 9 = G59.3)';
  if (num >= 5221 && num <= 5230) return 'G54 coordinate system offset';
  if (num >= 5241 && num <= 5500) return 'G55–G59.3 coordinate system offsets';
  if (num >= 5400 && num <= 5409) return 'current tool / tool-change parameters';
  if (num >= 5420 && num <= 5428) return 'current commanded position (X Y Z A B C U V W) in the active system';
  return 'numbered parameter (volatile unless persisted via the [RS274NGC] var file)';
}

// --- Hover ------------------------------------------------------------------

export function hoverGcode(text: string, lineIndex: LineIndex, offset: number, index: MetadataIndex): Hover | null {
  const tok = gcodeTokenAt(tokenizeGcode(text), offset);
  if (!tok) return null;
  const r = lineIndex.rangeAt(tok.start, tok.end);

  switch (tok.kind) {
    case GcodeTokenKind.Word: {
      if (tok.code) {
        const w = index.gcodeWord(tok.code);
        if (w) {
          const head = `### \`${w.code}\`${w.title ? ` — ${w.title}` : ''}`;
          return md(w.docMd ? `${head}\n\n${w.docMd}` : head, r);
        }
        return md(`\`${tok.code}\` — G/M code`, r);
      }
      const desc = tok.letter ? LETTER_DOC[tok.letter] : undefined;
      if (desc) {
        const val = tok.value ? ` — value \`${tok.value}\`` : '';
        return md(`**\`${tok.letter}\`** — ${desc}${val}`, r);
      }
      return null;
    }
    case GcodeTokenKind.Param: {
      const inner = /^#+<?([^>]*)>?$/.exec(tok.text)?.[1] ?? '';
      if (/^\d+$/.test(inner)) return md(`**parameter \`${tok.text}\`** — ${numberedParamDoc(parseInt(inner, 10))}`, r);
      if (inner.startsWith('_')) return md(`**global named parameter \`${tok.text}\`** — visible across all subroutines`, r);
      return md(`**named parameter \`${tok.text}\`** — local to the current subroutine scope`, r);
    }
    case GcodeTokenKind.Oword:
      return md(`**O-word \`${tok.text}\`** — labels a subroutine or control-flow block`, r);
    case GcodeTokenKind.OKeyword: {
      const doc = O_KEYWORD_DOC[tok.text.toLowerCase()];
      return doc ? md(`**\`${tok.text}\`** — ${doc}`, r) : null;
    }
    default:
      return null;
  }
}

// --- Completion -------------------------------------------------------------

export function completeGcode(text: string, lineIndex: LineIndex, offset: number, index: MetadataIndex): CompletionItem[] {
  let ls = offset;
  while (ls > 0 && text[ls - 1] !== '\n') ls--;
  const prefix = text.slice(ls, offset);

  // O-word keyword position: after an O<name>/O<num> token.
  const ow = /[oO](?:<[^>]*>|\d+)\s+([A-Za-z]*)$/.exec(prefix);
  if (ow) {
    const typed = ow[1];
    const range = lineIndex.rangeAt(offset - typed.length, offset);
    return [...O_KEYWORDS]
      .filter((k) => !typed || k.startsWith(typed.toLowerCase()))
      .map((k) => mkItem(k, range, CompletionItemKind.Keyword, O_KEYWORD_DOC[k]));
  }

  // G/M code position: a letter + partial number at the cursor.
  const gm = /([GMgm])(\d*\.?\d*)$/.exec(prefix);
  if (gm) {
    const typed = (gm[1] + gm[2]).toUpperCase();
    const letter = gm[1].toUpperCase();
    const range = lineIndex.rangeAt(offset - typed.length, offset);
    return allWords(index)
      .filter((w) => w.code.startsWith(letter) && w.code.startsWith(typed))
      .map((w) => mkItem(w.code, range, CompletionItemKind.Keyword, w.docMd, w.title));
  }
  return [];
}

function allWords(index: MetadataIndex): Array<{ code: string; title?: string; docMd?: string }> {
  return Object.values(index.raw().gcodeWords);
}

function mkItem(label: string, range: Range, kind: CompletionItemKind, doc?: string, detail?: string): CompletionItem {
  return {
    label,
    kind,
    detail,
    documentation: doc ? { kind: MarkupKind.Markdown, value: doc } : undefined,
    filterText: label,
    textEdit: TextEdit.replace(range, label),
  };
}

/** Exposed for tests that want the token stream directly. */
export type { GcodeToken };
