// Tokenizer for RS274NGC G-code. Line-oriented; produces tokens with absolute
// offsets for hover / completion / future semantic tokens.

export enum GcodeTokenKind {
  Word = 'word', // a letter + value, e.g. G1, X1.5, F100, S2000
  Param = 'param', // #<name> or #123 or #<_global>
  Comment = 'comment', // ( ... ) or ; ...
  Oword = 'oword', // O<number> or O<name>
  OKeyword = 'okeyword', // sub/endsub/if/while/call/...
  Number = 'number',
  Operator = 'operator', // [ ] = + - * / and named ops inside expressions
  Unknown = 'unknown',
}

export interface GcodeToken {
  kind: GcodeTokenKind;
  start: number;
  end: number;
  text: string;
  /** For Word: the uppercase address letter (G, M, X, F, ...). */
  letter?: string;
  /** For Word: the value text following the letter (may be empty). */
  value?: string;
  /** For Word: a normalized lookup code — `G1`/`M3`/`G38.2` for G&M codes, or
   *  the bare letter for F/S/T. Undefined for axis/parameter words. */
  code?: string;
}

export const O_KEYWORDS: ReadonlySet<string> = new Set([
  'sub', 'endsub', 'call', 'return',
  'if', 'elseif', 'else', 'endif',
  'while', 'endwhile', 'do',
  'repeat', 'endrepeat',
  'break', 'continue',
]);

/** Letters that, combined with a number, name a documented code (G1, M3, ...). */
const CODE_LETTERS = new Set(['G', 'M']);
/** Single-letter words that are themselves documented (F, S, T). */
const LETTER_WORDS = new Set(['F', 'S', 'T']);

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');

export function tokenizeGcode(text: string): GcodeToken[] {
  const out: GcodeToken[] = [];
  const n = text.length;
  let i = 0;
  let bracketDepth = 0;

  while (i < n) {
    const c = text[i];
    if (isWs(c)) { i++; continue; }

    // Comments: ( ... ) inline, or ; to end of line.
    if (c === '(') {
      const start = i;
      i++;
      while (i < n && text[i] !== ')' && text[i] !== '\n' && text[i] !== '\r') i++;
      if (i < n && text[i] === ')') i++;
      out.push({ kind: GcodeTokenKind.Comment, start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === ';') {
      const start = i;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      out.push({ kind: GcodeTokenKind.Comment, start, end: i, text: text.slice(start, i) });
      continue;
    }

    // Parameters: #<name>, #123, ##123, #<_global>
    if (c === '#') {
      const start = i;
      while (i < n && text[i] === '#') i++;
      if (text[i] === '<') {
        while (i < n && text[i] !== '>' && text[i] !== '\n' && text[i] !== '\r') i++;
        if (i < n && text[i] === '>') i++;
      } else {
        while (i < n && isDigit(text[i])) i++;
      }
      out.push({ kind: GcodeTokenKind.Param, start, end: i, text: text.slice(start, i) });
      continue;
    }

    // Brackets / operators (expression context).
    if (c === '[') { bracketDepth++; out.push(op(text, i)); i++; continue; }
    if (c === ']') { if (bracketDepth) bracketDepth--; out.push(op(text, i)); i++; continue; }
    if (c === '=' || c === '+' || c === '*' || c === '/') { out.push(op(text, i)); i++; continue; }

    if (isLetter(c)) {
      const start = i;
      const letter = c.toUpperCase();

      // Inside an expression, a letter run is an identifier/function name, not
      // an address word (avoids parsing ATAN as an A word).
      if (bracketDepth > 0) {
        i++;
        while (i < n && isLetter(text[i])) i++;
        out.push({ kind: GcodeTokenKind.Unknown, start, end: i, text: text.slice(start, i) });
        continue;
      }

      // O-word: O<number> or O<name>, then (after whitespace) a keyword.
      if (letter === 'O') {
        i++;
        if (text[i] === '<') {
          while (i < n && text[i] !== '>' && text[i] !== '\n' && text[i] !== '\r') i++;
          if (i < n && text[i] === '>') i++;
        } else {
          while (i < n && isDigit(text[i])) i++;
        }
        out.push({ kind: GcodeTokenKind.Oword, start, end: i, text: text.slice(start, i) });
        // optional following keyword
        let j = i;
        while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
        if (isLetter(text[j])) {
          const ks = j;
          while (j < n && isLetter(text[j])) j++;
          const kw = text.slice(ks, j);
          if (O_KEYWORDS.has(kw.toLowerCase())) {
            out.push({ kind: GcodeTokenKind.OKeyword, start: ks, end: j, text: kw });
            i = j;
          }
        }
        continue;
      }

      // Address word: letter + numeric value (value may be empty if a param /
      // expression follows instead).
      i++;
      const vStart = i;
      i = scanNumber(text, i);
      const value = text.slice(vStart, i);
      const tok: GcodeToken = { kind: GcodeTokenKind.Word, start, end: i, text: text.slice(start, i), letter, value };
      // A G/M code number is a plain integer or decimal (G1, G38.2) — never an
      // exponent form (G1e9 must NOT normalize to G1).
      if (value && CODE_LETTERS.has(letter) && /^\d+(?:\.\d+)?$/.test(value)) tok.code = letter + normalizeNum(value);
      else if (LETTER_WORDS.has(letter)) tok.code = letter;
      out.push(tok);
      continue;
    }

    // Bare number (e.g. a value after a word that we already consumed, or in an
    // expression) or sign.
    if (isDigit(c) || c === '.' || c === '-') {
      const start = i;
      i = scanNumber(text, i + 1);
      if (i === start) i++; // ensure progress
      out.push({ kind: GcodeTokenKind.Number, start, end: i, text: text.slice(start, i) });
      continue;
    }

    out.push({ kind: GcodeTokenKind.Unknown, start: i, end: i + 1, text: c });
    i++;
  }
  return out;
}

function op(text: string, i: number): GcodeToken {
  return { kind: GcodeTokenKind.Operator, start: i, end: i + 1, text: text[i] };
}

/** Scan a numeric literal starting at `i`; returns the index past it. */
function scanNumber(text: string, i: number): number {
  const n = text.length;
  let j = i;
  if (text[j] === '+' || text[j] === '-') j++;
  let sawDigit = false;
  while (j < n && (text[j] >= '0' && text[j] <= '9')) { j++; sawDigit = true; }
  if (text[j] === '.') { j++; while (j < n && text[j] >= '0' && text[j] <= '9') { j++; sawDigit = true; } }
  if (sawDigit && (text[j] === 'e' || text[j] === 'E')) {
    let k = j + 1;
    if (text[k] === '+' || text[k] === '-') k++;
    if (k < n && text[k] >= '0' && text[k] <= '9') { k++; while (k < n && text[k] >= '0' && text[k] <= '9') k++; j = k; }
  }
  return sawDigit ? j : i;
}

/** Normalize a code's numeric part by pure string ops (G01 -> 1, G38.20 -> 38.2).
 *  Never routes through Number, so large/precise values keep their digits and
 *  can't pick up exponent notation. Input is always plain `\d+(\.\d+)?`. */
function normalizeNum(v: string): string {
  if (v.includes('.')) {
    const [rawInt, rawFrac = ''] = v.split('.');
    const intPart = rawInt.replace(/^0+(?=\d)/, '') || '0';
    const fracPart = rawFrac.replace(/0+$/, '');
    return fracPart ? `${intPart}.${fracPart}` : intPart;
  }
  return v.replace(/^0+(?=\d)/, '') || '0';
}

/** The token under `offset`, if any. */
export function gcodeTokenAt(tokens: GcodeToken[], offset: number): GcodeToken | undefined {
  return tokens.find((t) => offset >= t.start && offset <= t.end);
}
