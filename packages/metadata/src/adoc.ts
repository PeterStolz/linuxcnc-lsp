// Best-effort AsciiDoc -> Markdown converter, scoped to the constructs that
// appear in LinuxCNC's man9 / config docs (not a full AsciiDoc engine). Output
// is rendered in LSP hover tooltips.

export function adocToMarkdown(adoc: string): string {
  const lines = adoc.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let inAdmonition: string | null = null;
  let admFence = false;

  for (const raw of lines) {
    let line = raw;

    // Index macros (((...))) -> removed (one level of inner parens tolerated).
    line = line.replace(/\(\(\((?:[^()]|\([^()]*\))*\)\)\)/g, '');

    // Admonition block: [NOTE] / [WARNING] etc. followed by ==== fences
    const adm = /^\[(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/.exec(line.trim());
    if (adm) {
      inAdmonition = adm[1];
      continue;
    }
    if (/^====+\s*$/.test(line.trim())) {
      // First fence after [NOTE] opens the block; the matching fence closes it.
      if (inAdmonition) {
        if (admFence) { inAdmonition = null; admFence = false; } else admFence = true;
      }
      continue;
    }

    // Headings: =, ==, === ... -> #, ##, ###
    const h = /^(=+)\s+(.*)$/.exec(line);
    if (h) {
      out.push(`${'#'.repeat(Math.min(h[1].length, 6))} ${inline(h[2])}`);
      continue;
    }

    // Definition list term:  "Foo::"  -> bold term
    const dl = /^(\S.*)::\s*$/.exec(line);
    if (dl) {
      out.push(`**${inline(dl[1])}**`);
      continue;
    }
    // Inline definition: "term:: description"
    const dli = /^(\S[^:]*)::\s+(.*)$/.exec(line);
    if (dli) {
      out.push(`**${inline(dli[1])}** — ${inline(dli[2])}`);
      continue;
    }

    if (/^\|===/.test(line)) continue; // table fence

    const prefix = inAdmonition && line.trim() ? '> ' : '';
    // A blank line ends a non-fenced (single-paragraph) admonition.
    if (inAdmonition && !admFence && !line.trim()) inAdmonition = null;
    out.push(prefix + inline(line));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Inline markup conversions. */
function inline(s: string): string {
  let r = s;
  // inline/block images: image:path[attrs] / image::path[attrs] -> dropped
  // (the images live in the docs tree and don't resolve inside a hover).
  r = r.replace(/image::?[^\s\[]+\[[^\]]*\]/g, '').replace(/,\s*$/, '');
  // superscript ^x^ / subscript ~x~ -> plain text (no markdown equivalent)
  r = r.replace(/\^(\S+?)\^/g, '$1');
  // links:  link:page[label]  /  https://x[label]
  r = r.replace(/link:(\S+?)\[([^\]]*)\]/g, (_m, u, label) => label || u);
  r = r.replace(/(https?:\/\/[^\s[]+)\[([^\]]*)\]/g, (_m, url, label) => `[${label || url}](${url})`);
  // cross references <<anchor,Text>> -> Text ; <<anchor>> -> anchor
  r = r.replace(/<<[^,>]+,([^>]+)>>/g, '$1').replace(/<<([^>]+)>>/g, '$1');
  // asciidoc monospace +code+ -> `code`
  r = r.replace(/(^|\s)\+([^+\s][^+]*?)\+(?=\s|$|[.,;:])/g, '$1`$2`');
  // single-star asciidoc bold -> markdown **bold**, leaving existing ** alone
  r = r.replace(/(?<![*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '**$1**');
  // asciidoc double-underscore italic -> markdown _italic_
  r = r.replace(/__([^_]+)__/g, '_$1_');
  return r;
}

/** Split an asciidoc document into sections keyed by their heading text, at a
 *  given heading level (number of '=' chars). Returns heading -> body adoc. */
export function splitSections(adoc: string, level: number): Map<string, string> {
  const lines = adoc.replace(/\r/g, '').split('\n');
  const sections = new Map<string, string>();
  const headingRe = new RegExp(`^={${level}}\\s+(.*)$`);
  const anyHeadingRe = /^(=+)\s+/;
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buf.join('\n').trim());
  };
  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      flush();
      current = m[1].trim();
      buf = [];
      continue;
    }
    const any = anyHeadingRe.exec(line);
    if (any && any[1].length <= level && current !== null) {
      flush();
      current = null;
      buf = [];
      continue;
    }
    if (current !== null) buf.push(line);
  }
  flush();
  return sections;
}
