// AST for RS274NGC O-word structure (subroutines + control flow). Built on top
// of the line-oriented tokenizer; carries absolute offsets so providers can map
// to LSP ranges via LineIndex. The parser is tolerant: malformed nesting becomes
// `problems` rather than thrown errors, so the rest of the file still analyzes.

/** The recognized O-word keywords (lowercased). Mirrors O_KEYWORDS. */
export type OKeyword =
  | 'sub' | 'endsub' | 'call' | 'return'
  | 'if' | 'elseif' | 'else' | 'endif'
  | 'while' | 'endwhile' | 'do'
  | 'repeat' | 'endrepeat'
  | 'break' | 'continue';

/** How an O-word's label is written. Only `named`/`numbered` have a static key
 *  that can be matched across statements (and, for named, resolved to a file). */
export type OWordForm = 'named' | 'numbered' | 'computed' | 'indirect';

/** A reference to an O-word label, e.g. `o<probe>`, `O100`, `o[#1]`, `o#5`. */
export interface OWordRef {
  /** Raw token text including the leading `o`/`O`. */
  raw: string;
  form: OWordForm;
  /** Original label text used for file resolution: the inner name for `named`,
   *  the normalized digits for `numbered`. Undefined for computed/indirect. */
  name?: string;
  /** Normalized match key: lowercased name (`named`) or leading-zero-stripped
   *  digits (`numbered`). Undefined when the label is dynamic and unmatchable. */
  key?: string;
  start: number;
  end: number;
}

/** One `O<label> <keyword> ...` statement. */
export interface OStatement {
  oword: OWordRef;
  keyword: OKeyword;
  keywordStart: number;
  keywordEnd: number;
  /** 0-based physical line of the O-word. */
  line: number;
}

export type GcodeBlockKind = 'sub' | 'if' | 'while' | 'do' | 'repeat';

/** A matched (or unclosed) O-word block. Object identity is shared with the
 *  parser stack so `close`/`endLine` are filled in when the closer is found. */
export interface GcodeBlock {
  kind: GcodeBlockKind;
  key?: string;
  open: OStatement;
  close?: OStatement;
  startLine: number;
  endLine: number;
  /** Set on an `if` block once an `else` has been seen (to flag a 2nd one). */
  elseSeen?: boolean;
}

/** A subroutine definition (named or numbered). `close` is undefined if the
 *  matching `endsub` is missing. */
export interface SubDef {
  key: string;
  form: OWordForm;
  open: OStatement;
  block: GcodeBlock;
}

/** A structural problem, consumed by diagnoseGcodeIntraFile (with a rule id). */
export interface GcodeProblem {
  code: string;
  start: number;
  end: number;
  message: string;
}

/** Parsed O-word view of a G-code document. */
export interface GcodeProgram {
  /** Every O-word statement, in source order. */
  statements: OStatement[];
  /** Every block (closed and unclosed), in open order. */
  blocks: GcodeBlock[];
  /** Subroutine definitions, in source order. */
  subs: SubDef[];
  /** Every `call` statement. */
  calls: OStatement[];
  /** Indent nesting depth per 0-based physical line (for the formatter). */
  lineDepth: number[];
  /** Structural problems for diagnostics. */
  problems: GcodeProblem[];
  lineCount: number;
}
