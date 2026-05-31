/** Lexical token kinds for HAL (halcmd) files. */
export enum HalTokenKind {
  Word = 'word', // bare identifier / pin / signal / component / value
  Number = 'number',
  String = 'string',
  IniRef = 'iniref', // [SECTION]KEY or [SECTION](KEY)
  EnvVar = 'envvar', // $VAR or $(VAR)
  Arrow = 'arrow', // => or <=
  Equals = 'equals', // =
  Comment = 'comment',
  Unknown = 'unknown',
}

export interface IniRefParts {
  section: string;
  key: string;
  /** Offsets (absolute) of the section-name and key-name substrings. */
  sectionStart: number;
  sectionEnd: number;
  keyStart: number;
  keyEnd: number;
}

export interface HalToken {
  kind: HalTokenKind;
  /** Absolute character offsets into the document. */
  start: number;
  end: number;
  text: string;
  /** Populated for IniRef tokens. */
  ini?: IniRefParts;
  /** Populated for EnvVar tokens: the variable name without $ / parens. */
  envName?: string;
}

/**
 * One logical line of HAL, after joining backslash continuations. `tokens`
 * excludes comments-as-statements but keeps an optional trailing comment.
 */
export interface HalLogicalLine {
  tokens: HalToken[];
  comment?: HalToken;
  /** Absolute offsets spanning the logical (possibly multi-physical) line. */
  start: number;
  end: number;
}
