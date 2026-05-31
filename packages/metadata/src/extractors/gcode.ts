import { GcodeWordDef } from '../types';
import { adocToMarkdown } from '../adoc';

// Extract G/M/F/S/T word documentation from LinuxCNC's gcode adoc sources.
// Two complementary sources per file:
//   * a "Quick Reference" table mapping each code to a one-line description, and
//   * per-code sections (anchored by `[[gcode:g0]]` then `== G0 Rapid Move`).

const CODE_RE = /^[A-Za-z]\d+(?:\.\d+)?$/;

interface QuickRef { codes: string[]; title: string; }
interface Section { heading: string; body: string[]; }

/** Build the gcodeWords map from g-code.adoc, m-code.adoc and other-code.adoc. */
export function extractGcode(gcodeAdoc: string, mcodeAdoc: string, otherAdoc: string): Record<string, GcodeWordDef> {
  const out: Record<string, GcodeWordDef> = {};
  const put = (code: string, def: Partial<GcodeWordDef>): void => {
    const c = code.toUpperCase();
    const prev = out[c] ?? { code: c };
    out[c] = { code: c, title: def.title ?? prev.title, docMd: def.docMd ?? prev.docMd };
  };

  for (const adoc of [gcodeAdoc, mcodeAdoc]) {
    const refs = parseQuickRef(adoc);
    const sections = parseAnchoredSections(adoc);
    for (const [anchor, ref] of refs) {
      const sec = sections.get(anchor);
      const docMd = sec ? buildDoc(sec.body) : undefined;
      for (const code of ref.codes) put(code, { title: ref.title, docMd });
    }
    // Sections whose codes never appeared in the quick-ref table.
    for (const sec of sections.values()) {
      const codes = (sec.heading.match(/\b[A-Za-z]\d+(?:\.\d+)?\b/g) ?? []).filter((c) => CODE_RE.test(c));
      for (const code of codes) {
        if (!out[code.toUpperCase()]) put(code, { title: stripLeadingCodes(sec.heading), docMd: buildDoc(sec.body) });
      }
    }
  }

  // other-code.adoc: `== F: Set Feed Rate` style single-letter words.
  for (const sec of parseColonSections(otherAdoc)) {
    put(sec.code, { title: sec.title, docMd: buildDoc(sec.body) });
  }
  return out;
}

/** Parse `|<<gcode:g0,G0>> |Coordinated Motion...` quick-reference rows. */
function parseQuickRef(adoc: string): Map<string, QuickRef> {
  const out = new Map<string, QuickRef>();
  const re = /^\|\s*<<([^,>]+),([^>]+)>>\s*\|\s*(.+?)\s*$/;
  for (const line of adoc.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const anchor = m[1].trim().replace(/^(?:gcode|mcode|ocode):/, '');
    const codes = m[2].split(/[\s,]+/).filter((t) => CODE_RE.test(t));
    if (!codes.length) continue;
    out.set(anchor, { codes, title: adocToMarkdown(m[3]).trim() });
  }
  return out;
}

/** Map `[[gcode:xxx]]` anchors to their `== Heading` + body (up to the next anchor). */
function parseAnchoredSections(adoc: string): Map<string, Section> {
  const out = new Map<string, Section>();
  const lines = adoc.split('\n');
  const anchorRe = /^\[\[(?:gcode|mcode|ocode):([^\]]+)\]\]\s*$/;
  let i = 0;
  while (i < lines.length) {
    const am = anchorRe.exec(lines[i]);
    if (!am) { i++; continue; }
    const anchor = am[1].trim();
    i++;
    // Skip blanks to the heading line.
    while (i < lines.length && !lines[i].trim()) i++;
    const hm = /^==+\s+(.*)$/.exec(lines[i] ?? '');
    if (!hm) continue;
    const heading = hm[1].replace(/\(\(\([^)]*\)\)\)/g, '').trim();
    i++;
    const body: string[] = [];
    while (i < lines.length && !anchorRe.test(lines[i])) body.push(lines[i++]);
    out.set(anchor, { heading, body });
  }
  return out;
}

/** Parse `== F: Set Feed Rate` sections from other-code.adoc. */
function parseColonSections(adoc: string): Array<{ code: string; title: string; body: string[] }> {
  const out: Array<{ code: string; title: string; body: string[] }> = [];
  const lines = adoc.split('\n');
  const re = /^==\s+([A-Za-z]):\s*(.+?)\s*$/;
  let cur: { code: string; title: string; body: string[] } | undefined;
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { code: m[1].toUpperCase(), title: m[2].trim(), body: [] };
    } else if (cur) {
      if (/^==\s/.test(line)) { out.push(cur); cur = undefined; }
      else cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Render a concise hover doc: the first `----` synopsis block (as ngc code) +
 *  the first prose paragraph. */
function buildDoc(body: string[]): string {
  const synopsis = firstFenced(body);
  const prose = firstProse(body);
  const parts: string[] = [];
  if (synopsis) parts.push('```ngc\n' + synopsis + '\n```');
  if (prose) parts.push(adocToMarkdown(prose));
  return parts.join('\n\n').trim();
}

function firstFenced(body: string[]): string | undefined {
  let inside = false;
  const buf: string[] = [];
  for (const line of body) {
    if (/^(----+|\.\.\.\.+)\s*$/.test(line)) {
      if (inside) return buf.join('\n').trim();
      inside = true;
      continue;
    }
    if (inside) buf.push(line);
  }
  return undefined;
}

function firstProse(body: string[]): string | undefined {
  const para: string[] = [];
  let inFence = false;
  for (const line of body) {
    if (/^(----+|\.\.\.\.+)\s*$/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const t = line.trim();
    if (!t) { if (para.length) break; else continue; }
    if (/^(\[|=+\s|\.|\/\/|\*|image:)/.test(t)) { if (para.length) break; else continue; }
    para.push(t);
  }
  return para.length ? para.join(' ') : undefined;
}

function stripLeadingCodes(heading: string): string {
  return heading.replace(/^(?:[A-Za-z]\d+(?:\.\d+)?[\s,]*)+/, '').trim() || heading;
}
