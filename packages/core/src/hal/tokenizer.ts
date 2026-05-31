import { HalToken, HalTokenKind, HalLogicalLine, IniRefParts } from './tokens';

const NUMBER_RE =
  /^(?:[+-]?0[xX][0-9a-fA-F]+|[+-]?0[oO][0-7]+|[+-]?0[bB][01]+|[+-]?\d+\.\d+(?:[eE][+-]?\d+)?|[+-]?\d+[eE][+-]?\d+|[+-]?\d+\.?|[+-]?\.\d+)$/;

/** Characters that terminate a bare word token. */
function isWordBoundary(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\r' ||
    ch === '\n' ||
    ch === '#' ||
    ch === '=' ||
    ch === '<' ||
    ch === '>' ||
    ch === '[' ||
    ch === '$' ||
    ch === '"' ||
    ch === "'" ||
    ch === '('
  );
}

/**
 * Tokenize the HAL document into logical lines, joining trailing-backslash
 * continuations. Offsets are absolute into the original (unjoined) text, so
 * diagnostics and navigation point at the correct physical location.
 */
export function tokenizeHal(text: string): HalLogicalLine[] {
  const lines: HalLogicalLine[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lineStart = i;
    const tokens: HalToken[] = [];
    let comment: HalToken | undefined;

    // Scan one logical line: consume physical lines while a line ends with an
    // unescaped trailing backslash.
    let inLine = true;
    while (inLine && i < n) {
      const ch = text[i];

      if (ch === '\n') {
        i++;
        inLine = false;
        break;
      }
      if (ch === '\r') {
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }

      // Line continuation: a backslash immediately followed by (optional \r) \n.
      if (ch === '\\') {
        let j = i + 1;
        if (text[j] === '\r') j++;
        if (text[j] === '\n') {
          i = j + 1; // jump past the newline, stay on the same logical line
          continue;
        }
        // A stray backslash not at EOL: treat as part of a word.
      }

      if (ch === '#') {
        // Rest of the physical line is a comment. (Continuation does not apply
        // after a comment begins.)
        let j = i;
        while (j < n && text[j] !== '\n') j++;
        comment = { kind: HalTokenKind.Comment, start: i, end: j, text: text.slice(i, j) };
        i = j;
        continue;
      }

      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < n && text[j] !== quote && text[j] !== '\n') {
          if (text[j] === '\\' && j + 1 < n) j++;
          j++;
        }
        if (j < n && text[j] === quote) j++; // include closing quote
        tokens.push({ kind: HalTokenKind.String, start: i, end: j, text: text.slice(i, j) });
        i = j;
        continue;
      }

      if (ch === '[') {
        const ref = matchIniRef(text, i);
        if (ref) {
          tokens.push(ref);
          i = ref.end;
          continue;
        }
        // Not a well-formed iniref; fall through as a word starting with '['.
      }

      if (ch === '$') {
        const env = matchEnvVar(text, i);
        if (env) {
          tokens.push(env);
          i = env.end;
          continue;
        }
      }

      if (ch === '=') {
        if (text[i + 1] === '>') {
          tokens.push({ kind: HalTokenKind.Arrow, start: i, end: i + 2, text: '=>' });
          i += 2;
        } else {
          tokens.push({ kind: HalTokenKind.Equals, start: i, end: i + 1, text: '=' });
          i += 1;
        }
        continue;
      }

      if (ch === '<') {
        if (text[i + 1] === '=') {
          tokens.push({ kind: HalTokenKind.Arrow, start: i, end: i + 2, text: '<=' });
          i += 2;
        } else {
          tokens.push({ kind: HalTokenKind.Unknown, start: i, end: i + 1, text: '<' });
          i += 1;
        }
        continue;
      }

      if (ch === '>') {
        tokens.push({ kind: HalTokenKind.Unknown, start: i, end: i + 1, text: '>' });
        i += 1;
        continue;
      }

      // Bare word / number: read up to the next boundary.
      let j = i;
      while (j < n && !isWordBoundary(text[j])) j++;
      if (j === i) {
        // The character is a boundary that no branch above consumed (e.g. a
        // stray '(' or a '[' that did not form a valid INI ref). Emit it as a
        // single Unknown token so we always make forward progress.
        tokens.push({ kind: HalTokenKind.Unknown, start: i, end: i + 1, text: text[i] });
        i++;
        continue;
      }
      const raw = text.slice(i, j);
      const kind = NUMBER_RE.test(raw) ? HalTokenKind.Number : HalTokenKind.Word;
      tokens.push({ kind, start: i, end: j, text: raw });
      i = j;
    }

    const lineEnd = i > lineStart && text[i - 1] === '\n' ? i - 1 : i;
    if (tokens.length > 0 || comment) {
      lines.push({ tokens, comment, start: lineStart, end: lineEnd });
    }
  }

  return lines;
}

/** Match `[SECTION]KEY` or `[SECTION](KEY)` at offset `start` (text[start]==='['). */
function matchIniRef(text: string, start: number): HalToken | undefined {
  const re = /^\[([A-Za-z_][A-Za-z0-9_]*)\](\(?)([A-Za-z_][A-Za-z0-9_]*)(\)?)/;
  const slice = text.slice(start);
  const m = re.exec(slice);
  if (!m) return undefined;
  // If there's an open paren it must be balanced by a close paren.
  if (m[2] === '(' && m[4] !== ')') return undefined;
  if (m[2] === '' && m[4] === ')') return undefined;
  const full = m[0];
  const section = m[1];
  const key = m[3];
  const sectionStart = start + 1;
  const sectionEnd = sectionStart + section.length;
  const keyStart = start + full.indexOf(key, 1 + section.length + 1);
  const ini: IniRefParts = {
    section,
    key,
    sectionStart,
    sectionEnd,
    keyStart,
    keyEnd: keyStart + key.length,
  };
  return {
    kind: HalTokenKind.IniRef,
    start,
    end: start + full.length,
    text: full,
    ini,
  };
}

/** Match `$VAR` or `$(VAR)` at offset `start` (text[start]==='$'). */
function matchEnvVar(text: string, start: number): HalToken | undefined {
  const slice = text.slice(start);
  let m = /^\$\(([A-Za-z_]\w*)\)/.exec(slice);
  if (m) {
    return {
      kind: HalTokenKind.EnvVar,
      start,
      end: start + m[0].length,
      text: m[0],
      envName: m[1],
    };
  }
  m = /^\$([A-Za-z_]\w*)/.exec(slice);
  if (m) {
    return {
      kind: HalTokenKind.EnvVar,
      start,
      end: start + m[0].length,
      text: m[0],
      envName: m[1],
    };
  }
  return undefined;
}
