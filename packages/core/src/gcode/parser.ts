import { LineIndex } from '../common/lineIndex';
import { tokenizeGcode, GcodeToken, GcodeTokenKind, O_KEYWORDS } from './tokenizer';
import {
  GcodeProgram, OStatement, OWordRef, OKeyword, GcodeBlock, GcodeBlockKind,
  SubDef, GcodeProblem,
} from './ast';

// Rule ids emitted as structural problems (resolved to diagnostics elsewhere).
const R = {
  unmatchedClose: 'gcode.oword.unmatchedClose',
  unclosed: 'gcode.oword.unclosed',
  labelMismatch: 'gcode.oword.labelMismatch',
  nestedSub: 'gcode.oword.nestedSub',
  duplicateSub: 'gcode.oword.duplicateSub',
  duplicateElse: 'gcode.oword.duplicateElse',
  returnOutsideSub: 'gcode.oword.returnOutsideSub',
  controlOutsideLoop: 'gcode.oword.controlOutsideLoop',
  missingKeyword: 'gcode.oword.missingKeyword',
} as const;

type Role = 'open' | 'close' | 'mid' | 'neutral';

const OPENER_OF: Record<string, GcodeBlockKind> = {
  endsub: 'sub', endif: 'if', endwhile: 'while', endrepeat: 'repeat',
};
const LOOP_KINDS = new Set<GcodeBlockKind>(['while', 'do', 'repeat']);

/** Classify an O-word label token into a form + normalized match key. */
export function classifyOword(raw: string, start: number, end: number): OWordRef {
  const body = raw.slice(1); // drop leading o/O
  if (body.startsWith('<')) {
    const close = body.indexOf('>');
    // RS274NGC ignores spaces/tabs inside an o-word name, so `o< probe >`,
    // `o<probe>` and `o<pr obe>` all denote the same subroutine — strip them all,
    // not just the ends, so the match key and file resolution agree.
    const inner = (close >= 0 ? body.slice(1, close) : body.slice(1)).replace(/[ \t]+/g, '');
    return { raw, form: 'named', name: inner || undefined, key: inner ? inner.toLowerCase() : undefined, start, end };
  }
  if (body.startsWith('[')) return { raw, form: 'computed', start, end };
  if (body.startsWith('#')) return { raw, form: 'indirect', start, end };
  if (/^[0-9]+$/.test(body)) {
    const norm = body.replace(/^0+(?=\d)/, '');
    return { raw, form: 'numbered', name: norm, key: norm, start, end };
  }
  // `o` alone or an otherwise unparseable label: no static key.
  return { raw, form: 'numbered', start, end };
}

/** Collect O-word statements from the token stream. Each is an `Oword` token
 *  immediately followed (the tokenizer guarantees same-line adjacency) by an
 *  `OKeyword` token. */
function collectStatements(
  tokens: GcodeToken[], lineIndex: LineIndex, problems: GcodeProblem[],
): OStatement[] {
  const out: OStatement[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== GcodeTokenKind.Oword) continue;
    const next = tokens[i + 1];
    if (next && next.kind === GcodeTokenKind.OKeyword && O_KEYWORDS.has(next.text.toLowerCase())) {
      out.push({
        oword: classifyOword(t.text, t.start, t.end),
        keyword: next.text.toLowerCase() as OKeyword,
        keywordStart: next.start,
        keywordEnd: next.end,
        line: lineIndex.positionAt(t.start).line,
      });
      i++; // consume the keyword token
    } else {
      // An O-word with no recognized keyword. A bare NUMBERED o-word (e.g. O1000)
      // is the Fanuc/ISO program-number header CAM posts emit on the first line —
      // not a LinuxCNC o-word mistake — so don't warn on it. A bare named `o<...>`
      // is an incomplete statement worth flagging.
      if (classifyOword(t.text, t.start, t.end).form !== 'numbered') {
        problems.push({
          code: R.missingKeyword,
          start: t.start, end: t.end,
          message: `O-word '${t.text}' is not followed by a keyword (sub, call, if, while, ...).`,
        });
      }
    }
  }
  return out;
}

/** Two labels are incompatible only when both are statically known and differ. */
function keysIncompatible(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

export function parseGcode(text: string): GcodeProgram {
  const lineIndex = new LineIndex(text);
  const tokens = tokenizeGcode(text);
  const problems: GcodeProblem[] = [];
  const statements = collectStatements(tokens, lineIndex, problems);

  const blocks: GcodeBlock[] = [];
  const subs: SubDef[] = [];
  const calls: OStatement[] = [];
  const stack: GcodeBlock[] = [];
  const definedSubKeys = new Set<string>();
  const role = new Map<OStatement, Role>();

  const problem = (code: string, st: OStatement, message: string): void => {
    problems.push({ code, start: st.oword.start, end: st.keywordEnd, message });
  };

  const openBlock = (kind: GcodeBlockKind, st: OStatement): GcodeBlock => {
    const blk: GcodeBlock = { kind, key: st.oword.key, open: st, startLine: st.line, endLine: st.line };
    stack.push(blk);
    blocks.push(blk);
    role.set(st, 'open');
    return blk;
  };

  /** Close the nearest block of `kind` (label-aware). Reports unmatched/label
   *  problems and pops any intervening unclosed blocks. */
  const closeBlock = (kind: GcodeBlockKind, st: OStatement, label: string): void => {
    // Strict-LIFO fast path.
    const top = stack[stack.length - 1];
    if (top && top.kind === kind) {
      if (keysIncompatible(top.key, st.oword.key)) {
        problem(R.labelMismatch, st, `${label} label '${st.oword.raw}' does not match its '${top.open.oword.raw}'.`);
      }
      stack.pop();
      top.close = st;
      top.endLine = st.line;
      role.set(st, 'close');
      return;
    }
    // Search downward for a same-kind, label-compatible opener.
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === kind && !keysIncompatible(stack[i].key, st.oword.key)) { idx = i; break; }
    }
    if (idx >= 0) {
      while (stack.length - 1 > idx) {
        const u = stack.pop()!;
        problem(R.unclosed, u.open, `'${u.open.oword.raw} ${u.kind}' is never closed.`);
      }
      const blk = stack.pop()!;
      blk.close = st;
      blk.endLine = st.line;
      role.set(st, 'close');
      return;
    }
    problem(R.unmatchedClose, st, `${label} has no matching '${kind}'.`);
    role.set(st, 'neutral');
  };

  for (const st of statements) {
    const kw = st.keyword;
    switch (kw) {
      case 'sub': {
        if (stack.some((b) => b.kind === 'sub')) {
          problem(R.nestedSub, st, 'A subroutine cannot be defined inside another subroutine.');
        }
        const blk = openBlock('sub', st);
        if (st.oword.key !== undefined) {
          if (definedSubKeys.has(st.oword.key)) {
            problem(R.duplicateSub, st, `Subroutine '${st.oword.raw}' is defined more than once.`);
          } else {
            definedSubKeys.add(st.oword.key);
          }
          subs.push({ key: st.oword.key, form: st.oword.form, open: st, block: blk });
        }
        break;
      }
      case 'if':
      case 'repeat':
        openBlock(kw, st);
        break;
      case 'do':
        openBlock('do', st);
        break;
      case 'while': {
        // Ambiguous: closes a `do` if one is the innermost open block, else it
        // opens a top-tested while loop.
        const top = stack[stack.length - 1];
        if (top && top.kind === 'do') {
          if (keysIncompatible(top.key, st.oword.key)) {
            problem(R.labelMismatch, st, `while label '${st.oword.raw}' does not match its '${top.open.oword.raw} do'.`);
          }
          stack.pop();
          top.close = st;
          top.endLine = st.line;
          role.set(st, 'close');
        } else {
          openBlock('while', st);
        }
        break;
      }
      case 'endsub':
      case 'endif':
      case 'endwhile':
      case 'endrepeat':
        closeBlock(OPENER_OF[kw], st, kw);
        break;
      case 'else':
      case 'elseif': {
        const top = stack[stack.length - 1];
        if (top && top.kind === 'if') {
          if (keysIncompatible(top.key, st.oword.key)) {
            problem(R.labelMismatch, st, `${kw} label '${st.oword.raw}' does not match its '${top.open.oword.raw} if'.`);
          }
          if (top.elseSeen) {
            problem(R.duplicateElse, st, kw === 'else'
              ? 'Multiple else branches in one if-block.'
              : 'elseif cannot follow else in an if-block.');
          }
          if (kw === 'else') top.elseSeen = true;
          role.set(st, 'mid');
        } else {
          problem(R.unmatchedClose, st, `${kw} has no matching 'if'.`);
          role.set(st, 'neutral');
        }
        break;
      }
      case 'call':
        calls.push(st);
        role.set(st, 'neutral');
        break;
      case 'return':
        if (!stack.some((b) => b.kind === 'sub')) {
          problem(R.returnOutsideSub, st, 'return outside a subroutine.');
        }
        role.set(st, 'neutral');
        break;
      case 'break':
      case 'continue':
        if (!stack.some((b) => LOOP_KINDS.has(b.kind))) {
          problem(R.controlOutsideLoop, st, `${kw} outside a while/do/repeat loop.`);
        }
        role.set(st, 'neutral');
        break;
      default:
        role.set(st, 'neutral');
        break;
    }
  }

  // Anything still open at EOF is unclosed; extend its fold to the last line.
  const lastLine = Math.max(0, lineIndex.lineCount - 1);
  for (const blk of stack) {
    blk.endLine = lastLine;
    problem(R.unclosed, blk.open, `'${blk.open.oword.raw} ${blk.kind}' is never closed.`);
  }

  const lineDepth = computeLineDepth(statements, role, lineIndex.lineCount);

  return { statements, blocks, subs, calls, lineDepth, problems, lineCount: lineIndex.lineCount };
}

/** Indent depth per physical line, derived from each O-statement's role. */
function computeLineDepth(
  statements: OStatement[], role: Map<OStatement, Role>, lineCount: number,
): number[] {
  // First O-statement per line drives that line's indent.
  const byLine = new Map<number, Role>();
  for (const st of statements) {
    if (!byLine.has(st.line)) byLine.set(st.line, role.get(st) ?? 'neutral');
  }
  const depth = new Array<number>(lineCount).fill(0);
  let cur = 0;
  for (let line = 0; line < lineCount; line++) {
    const r = byLine.get(line);
    depth[line] = (r === 'close' || r === 'mid') ? Math.max(0, cur - 1) : cur;
    if (r === 'open') cur++;
    else if (r === 'close') cur = Math.max(0, cur - 1);
  }
  return depth;
}
