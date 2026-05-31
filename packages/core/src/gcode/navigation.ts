import { Location, DocumentHighlight, DocumentHighlightKind } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { GcodeProgram, OStatement, OWordRef } from './ast';

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
