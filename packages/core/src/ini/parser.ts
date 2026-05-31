import { IniFile, IniSection, IniEntry, IniInclude, IniProblem, IniSpan } from './ast';

interface PhysLine {
  text: string; // without trailing newline
  start: number; // absolute offset of first char
  end: number; // absolute offset just past last char (before newline)
}

function splitLines(text: string): PhysLine[] {
  const lines: PhysLine[] = [];
  const n = text.length;
  let start = 0;
  const push = (end: number): void => {
    let e = end;
    if (e > start && text.charCodeAt(e - 1) === 13 /* \r */) e--; // strip CR of a CRLF
    lines.push({ text: text.slice(start, e), start, end: e });
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    // Break on LF, or on a bare CR not immediately followed by LF.
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      push(i);
      start = i + 1;
    }
  }
  if (start < n) push(n); // trailing line without a terminator
  return lines;
}

const SECTION_RE = /^(\s*)\[(\s*)([^\]]*?)(\s*)\]\s*(\S.*)?$/;
const ENTRY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;
const INCLUDE_RE = /^(\s*)#INCLUDE\s+(.*\S)\s*$/i;
const COMMENT_RE = /^\s*[#;]/;
const BLANK_RE = /^\s*$/;
const VALID_SECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse an INI document into sections/entries with precise offsets. Tolerant:
 *  malformed lines become problems but parsing continues. */
export function parseIni(text: string): IniFile {
  const physLines = splitLines(text);
  const sections: IniSection[] = [];
  const includes: IniInclude[] = [];
  const orphanEntries: IniEntry[] = [];
  const problems: IniProblem[] = [];
  let current: IniSection | undefined;

  const closeSection = (endOffset: number): void => {
    if (current) current.end = endOffset;
  };

  for (let li = 0; li < physLines.length; li++) {
    const line = physLines[li];
    const raw = line.text;

    if (BLANK_RE.test(raw)) continue;

    const inc = INCLUDE_RE.exec(raw);
    if (inc) {
      const fileText = inc[2];
      const fileStart = line.start + raw.indexOf(fileText, inc[1].length + '#INCLUDE'.length);
      includes.push({
        file: { text: fileText, start: fileStart, end: fileStart + fileText.length },
        start: line.start,
        end: line.end,
      });
      continue;
    }

    if (COMMENT_RE.test(raw)) continue;

    const sec = SECTION_RE.exec(raw);
    if (sec) {
      closeSection(line.start);
      const lead = sec[1].length;
      const innerLead = sec[2].length;
      const name = sec[3];
      const nameStart = line.start + lead + 1 + innerLead;
      const section: IniSection = {
        name: { text: name, start: nameStart, end: nameStart + name.length },
        headerStart: line.start,
        headerEnd: line.end,
        entries: [],
        start: line.start,
        end: line.end,
      };
      if (!VALID_SECTION_NAME.test(name)) {
        problems.push({
          start: section.name.start,
          end: section.name.end,
          message: `Invalid section name '${name}'`,
          code: 'ini.syntax.invalidSection',
        });
      }
      if (sec[5]) {
        problems.push({
          start: line.start,
          end: line.end,
          message: 'Unexpected text after section header',
          code: 'ini.syntax.trailingHeaderText',
        });
      }
      sections.push(section);
      current = section;
      continue;
    }

    const ent = ENTRY_RE.exec(raw);
    if (ent) {
      const lead = ent[1].length;
      const key = ent[2];
      const keyStart = line.start + lead;
      const firstValue = ent[4];
      const valueAbsStart = line.start + raw.length - firstValue.length;
      let lineEnd = line.end;

      // Value continuation: a trailing backslash joins subsequent physical lines.
      // Accumulate segments and join once (avoids O(n^2) growing-string concat).
      let value: IniSpan | undefined;
      if (/\\\s*$/.test(firstValue) && li + 1 < physLines.length) {
        const parts: string[] = [];
        let seg = firstValue;
        while (/\\\s*$/.test(seg) && li + 1 < physLines.length) {
          parts.push(seg.replace(/\\\s*$/, ''));
          li++;
          const next = physLines[li];
          seg = next.text;
          lineEnd = next.end;
        }
        parts.push(seg);
        const joined = parts.join('\n');
        const trimmed = joined.trim();
        if (trimmed.length) {
          // Span the value from its first non-ws char to the last physical line
          // end (physical offsets — the joined logical length must not be used
          // against a physical start offset).
          const start = valueAbsStart + (joined.length - joined.trimStart().length);
          value = { text: trimmed, start, end: Math.max(start + 1, lineEnd) };
        }
      } else {
        value = makeTrimmedSpan(firstValue, valueAbsStart);
      }
      const entry: IniEntry = {
        key: { text: key, start: keyStart, end: keyStart + key.length },
        value,
        start: line.start,
        end: lineEnd,
      };
      if (current) {
        current.entries.push(entry);
        current.end = lineEnd;
      } else {
        orphanEntries.push(entry);
        problems.push({
          start: entry.start,
          end: entry.end,
          message: `Key '${key}' appears before any [SECTION] header`,
          code: 'ini.syntax.entryOutsideSection',
        });
      }
      continue;
    }

    // Anything else on a non-blank, non-comment line is a syntax error.
    problems.push({
      start: line.start,
      end: line.end,
      message: 'Expected a [SECTION] header or KEY = VALUE entry',
      code: 'ini.syntax.malformedLine',
    });
  }

  closeSection(text.length);
  return { sections, includes, orphanEntries, problems };
}

/** Build a span for the trimmed value, or undefined when empty. */
function makeTrimmedSpan(rawValue: string, absStart: number): IniSpan | undefined {
  const leadingWs = rawValue.length - rawValue.trimStart().length;
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return undefined;
  const start = absStart + leadingWs;
  return { text: trimmed, start, end: start + trimmed.length };
}
