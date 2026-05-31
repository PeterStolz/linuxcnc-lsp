import { splitSections, adocToMarkdown } from '../adoc';

export interface ParsedMan9 {
  /** Component/module name from the `= name(9)` title. */
  name: string;
  /** One-line summary from the NAME section (text after " - "). */
  summary?: string;
  descriptionMd?: string;
  /** Cleaned pin/param template name -> rendered doc (best effort). */
  memberDocs: Record<string, string>;
}

/** Parse a man9 `.adoc` page (e.g. stepgen.9.adoc) for component docs. */
export function parseMan9(adoc: string): ParsedMan9 | undefined {
  const titleM = /^=\s+([A-Za-z0-9_.\-]+)\(9\)/m.exec(adoc);
  if (!titleM) return undefined;
  const name = titleM[1];

  const sections = splitSections(adoc, 2); // == SECTIONS
  const result: ParsedMan9 = { name, memberDocs: {} };

  const nameSec = sections.get('NAME');
  if (nameSec) {
    const m = /-\s+(.*)/.exec(nameSec.replace(/\n/g, ' '));
    if (m) result.summary = m[1].trim();
  }

  const desc = sections.get('DESCRIPTION');
  if (desc) result.descriptionMd = adocToMarkdown(desc);

  for (const sec of ['PINS', 'PARAMETERS', 'FUNCTIONS']) {
    const body = sections.get(sec);
    if (body) Object.assign(result.memberDocs, parseDefList(body));
  }

  return result;
}

/** Parse a man9 definition list: `**comp.**__N__**.pin** type dir::` + body. */
function parseDefList(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split('\n');
  let currentKey: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (currentKey) out[currentKey] = adocToMarkdown(buf.join('\n').trim());
  };
  for (const line of lines) {
    // A definition term ends with `::` and contains the (marked-up) member name.
    const dt = /^(\S.*)::\s*$/.exec(line) || /^(\S.*)::\s+(.*)$/.exec(line);
    if (dt) {
      flush();
      currentKey = cleanMemberName(dt[1]);
      buf = dt[2] ? [dt[2]] : [];
      continue;
    }
    if (currentKey) buf.push(line);
  }
  flush();
  return out;
}

/** Strip asciidoc markup from a member term, keeping the dotted HAL name and
 *  collapsing index placeholders to N. */
function cleanMemberName(term: string): string {
  let t = term;
  t = t.replace(/\*\*/g, '').replace(/__/g, '').replace(/\*/g, '').replace(/_/g, '');
  // Drop a trailing " type dir (...)" descriptor; keep the leading dotted name.
  const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-#]*)/.exec(t.trim());
  let name = m ? m[1] : t.trim();
  name = name.replace(/\bN\b/g, 'N').replace(/\.\.$/, '');
  return name.replace(/\.$/, '');
}
