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
      // The quick-ref cell only yields the range endpoints for spaced-dash
      // ranges ("G17 - G19.1"); the section's per-code bullets are the
      // authoritative full set (G17,G18,G19,G17.1,G18.1,G19.1).
      const codes = [...new Set([...ref.codes, ...(sec ? codesInBullets(sec.body) : [])])];
      const sharedDoc = sec ? buildDoc(sec.body) : undefined;
      const syn = sec ? firstFenced(sec.body) : undefined;
      for (const code of codes) {
        // A section documenting several codes via a `* 'G94' - ...` bullet list
        // must give each code ITS bullet, not the whole (first code's) body.
        let docMd = sharedDoc;
        if (sec && codes.length > 1) {
          const bullet = perCodeBullet(code, sec.body);
          if (bullet) docMd = [syn ? '```ngc\n' + syn + '\n```' : '', adocToMarkdown(bullet)].filter(Boolean).join('\n\n');
        }
        put(code, { title: ref.title, docMd });
      }
    }
    // Sections whose codes never appeared in the quick-ref table.
    for (const sec of sections.values()) {
      // The `(?!\.\D)` guard rejects a bare stem followed by a `.<non-digit>`
      // placeholder, e.g. `G38` in the heading `G38._n_ Straight Probe`.
      const codes = (sec.heading.match(/[A-Za-z]\d+(?:\.\d+)?(?:-[A-Za-z]?\d+(?:\.\d+)?)?(?!\.\D)/g) ?? []).flatMap(expandCodes);
      for (const code of codes) {
        if (out[code]) continue;
        // Don't synthesize a bare stem (G38) when dotted variants (G38.2 …) exist.
        if (Object.keys(out).some((k) => k.startsWith(code + '.'))) continue;
        put(code, { title: stripLeadingCodes(sec.heading), docMd: buildDoc(sec.body) });
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
    const codes = m[2].split(/[\s,]+/).flatMap(expandCodes);
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
    const heading = hm[1].replace(/\(\(\((?:[^()]|\([^()]*\))*\)\)\)/g, '').trim();
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
  // Allow dash (range) as a separator between leading codes so a heading like
  // "M100-M199 User Defined Commands" doesn't leave "-M199 ..." in the title.
  return heading.replace(/^(?:[A-Za-z]\d+(?:\.\d+)?\s*-?\s*)+/, '').trim() || heading;
}

/** Expand a code cell token into discrete codes. A plain code passes through; a
 *  dash-joined range (M62-M65, G54-G59.3) expands to its members; junk -> []. */
function expandCodes(token: string): string[] {
  const t = token.trim();
  if (CODE_RE.test(t)) return [t.toUpperCase()];
  const m = /^([A-Za-z])(\d+)(?:\.(\d+))?-([A-Za-z]?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return [];
  const letter = m[1].toUpperCase();
  const startInt = parseInt(m[2], 10);
  const endInt = parseInt(m[5], 10);
  const endDec = m[6] ? parseInt(m[6], 10) : 0;
  if (endInt < startInt || endInt - startInt > 256) {
    // Out-of-order or absurd range: just take the two endpoints.
    return [letter + m[2] + (m[3] ? '.' + m[3] : ''), (m[4] || letter).toUpperCase() + m[5] + (m[6] ? '.' + m[6] : '')];
  }
  const out: string[] = [];
  for (let n = startInt; n <= endInt; n++) out.push(letter + n);
  for (let d = 1; d <= endDec; d++) out.push(`${letter}${endInt}.${d}`);
  return out;
}

/** All G/M codes that head a `* 'G94' - ...` body bullet (the authoritative
 *  member list for a multi-code section). */
function codesInBullets(body: string[]): string[] {
  const out: string[] = [];
  for (const line of body) {
    const m = /^\s*\*\s*['`]?([A-Za-z]\d+(?:\.\d+)?)['`]?[\s.,'`-]/.exec(line);
    if (m && CODE_RE.test(m[1])) out.push(m[1].toUpperCase());
  }
  return out;
}

/** For a multi-code section, return the body bullet documenting `code`
 *  (`* 'G94' - ...`), joined with its continuation lines. */
function perCodeBullet(code: string, body: string[]): string | undefined {
  const re = new RegExp(`^\\*\\s*['\`]?${code}['\`]?[\\s.,'\`-]`, 'i');
  const i = body.findIndex((l) => re.test(l.trim()));
  if (i < 0) return undefined;
  const buf = [body[i].trim().replace(/^\*\s*/, '')];
  for (let j = i + 1; j < body.length; j++) {
    const t = body[j];
    if (/^\s*\*/.test(t) || t.trim() === '') break;
    buf.push(t.trim());
  }
  return buf.join(' ');
}
