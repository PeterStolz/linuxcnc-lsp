import { Location, DocumentHighlight, DocumentHighlightKind, Range } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { GcodeProgram, OStatement, OWordRef } from './ast';
import { O_KEYWORDS } from './tokenizer';

/** Keywords whose O-word names a subroutine (so the label is navigable). */
const SUB_KEYWORDS = new Set(['sub', 'endsub', 'call']);

/** The O-word reference under `offset`, if the cursor is on the label of a
 *  subroutine-related statement (sub / endsub / call). */
export function gcodeOwordAt(program: GcodeProgram, offset: number): OWordRef | undefined {
  for (const st of program.statements) {
    if (!SUB_KEYWORDS.has(st.keyword)) continue;
    const o = st.oword;
    // Accept a hit anywhere on the `O<label> <keyword>` span so it is easy to
    // trigger, but only return the navigable label reference.
    if (offset >= o.start && offset <= st.keywordEnd) return o;
  }
  return undefined;
}

/** Every sub/endsub/call statement referring to `key`. */
function occurrences(program: GcodeProgram, key: string): OStatement[] {
  return program.statements.filter(
    (st) => SUB_KEYWORDS.has(st.keyword) && st.oword.key === key,
  );
}

/** In-file go-to-definition: the `sub` line for the label under the cursor. */
export function gcodeDefinition(
  program: GcodeProgram, lineIndex: LineIndex, uri: string, offset: number,
): Location[] {
  const hit = gcodeOwordAt(program, offset);
  if (!hit?.key) return [];
  const def = program.subs.find((s) => s.key === hit.key);
  if (!def) return [];
  return [{ uri, range: lineIndex.rangeAt(def.open.oword.start, def.open.oword.end) }];
}

/** In-file find-references for the subroutine label under the cursor. */
export function gcodeReferences(
  program: GcodeProgram, lineIndex: LineIndex, uri: string, offset: number, includeDecl = true,
): Location[] {
  const hit = gcodeOwordAt(program, offset);
  if (!hit?.key) return [];
  return occurrences(program, hit.key)
    .filter((st) => includeDecl || st.keyword !== 'sub')
    .map((st) => ({ uri, range: lineIndex.rangeAt(st.oword.start, st.oword.end) }));
}

/** Same-file highlights for the subroutine label under the cursor. */
export function gcodeDocumentHighlights(
  program: GcodeProgram, lineIndex: LineIndex, offset: number,
): DocumentHighlight[] {
  const hit = gcodeOwordAt(program, offset);
  if (!hit?.key) return [];
  return occurrences(program, hit.key).map((st) => ({
    range: lineIndex.rangeAt(st.oword.start, st.oword.end),
    kind: st.keyword === 'sub' ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
  }));
}

/** The renameable O-word under `offset`: a named (`o<name>`) sub/endsub/call label.
 *  Numbered/computed/indirect labels have no editable name and are not renameable. */
export function gcodeRenameTarget(program: GcodeProgram, offset: number): OWordRef | undefined {
  const hit = gcodeOwordAt(program, offset);
  return hit && hit.form === 'named' && hit.key ? hit : undefined;
}

/** The range of the editable name inside an `o<name>` label — the text between the
 *  angle brackets — used for prepare-rename and rename edits. Undefined for a label
 *  that is not bracketed (numbered) or malformed. */
export function owordNameRange(oword: OWordRef, lineIndex: LineIndex): Range | undefined {
  const lt = oword.raw.indexOf('<');
  if (lt < 0) return undefined;
  const gt = oword.raw.indexOf('>');
  const start = oword.start + lt + 1;
  const end = gt >= 0 ? oword.start + gt : oword.end;
  if (end < start) return undefined;
  return lineIndex.rangeAt(start, end);
}

/** Is `name` a legal new o-word subroutine name? Rejects empty, whitespace, names
 *  with a path separator or angle bracket (would break the resolver / `o<>`
 *  grammar), and the reserved O-keywords. */
export function isValidOwordName(name: string): boolean {
  if (!name || /[<>\\/\s]/.test(name)) return false;
  return !O_KEYWORDS.has(name.toLowerCase());
}

/** Whole-token ranges of every NAMED sub/endsub/call sharing `key` (for cross-file
 *  find-references). Numbered labels are excluded — their key is just the number,
 *  so they are file-local and must not match across files. With `includeDecl`
 *  false the `sub` declaration is omitted. */
export function gcodeReferenceRangesInFile(
  program: GcodeProgram, lineIndex: LineIndex, key: string, includeDecl = true,
): Range[] {
  const out: Range[] = [];
  for (const st of program.statements) {
    if (!SUB_KEYWORDS.has(st.keyword)) continue;
    if (st.oword.form !== 'named' || st.oword.key !== key) continue;
    if (!includeDecl && st.keyword === 'sub') continue;
    out.push(lineIndex.rangeAt(st.oword.start, st.oword.end));
  }
  return out;
}

/** In-file rename ranges: the editable name span of every named sub/endsub/call
 *  sharing the label `key`. */
export function gcodeRenameRangesInFile(
  program: GcodeProgram, lineIndex: LineIndex, key: string,
): Range[] {
  const out: Range[] = [];
  for (const st of program.statements) {
    if (!SUB_KEYWORDS.has(st.keyword)) continue;
    if (st.oword.form !== 'named' || st.oword.key !== key) continue;
    const r = owordNameRange(st.oword, lineIndex);
    if (r) out.push(r);
  }
  return out;
}
