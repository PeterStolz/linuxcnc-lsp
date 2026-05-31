import { IniSectionSchema, IniKeyDef } from '../types';
import { splitSections, adocToMarkdown } from '../adoc';

/** Parse `ini-config.adoc` into a section/key schema. */
export function extractIniConfig(adoc: string): {
  sections: Record<string, IniSectionSchema>;
  consumedKeys: string[];
} {
  const sections: Record<string, IniSectionSchema> = {};
  const consumed = new Set<string>();
  const bySection = splitSections(adoc, 3);

  for (const [heading, body] of bySection) {
    const nameMatch = /\[([A-Za-z_][A-Za-z0-9_<>]*)\]/.exec(heading);
    if (!nameMatch) continue; // not a "[SECTION] Section" heading
    const sectionName = nameMatch[1];
    const instanced = /[<>]/.test(sectionName);
    const keys: Record<string, IniKeyDef> = {};
    for (const def of parseKeyBullets(body)) {
      keys[def.key.toLowerCase()] = def;
      consumed.add(def.key);
    }
    sections[sectionName] = {
      name: sectionName,
      instanced,
      keys,
      docMd: adocToMarkdown(firstParagraph(body)),
    };
  }
  return { sections, consumedKeys: [...consumed] };
}

/** Parse bullet lines of the form ``* `KEY = example` - (type) description``. */
function parseKeyBullets(body: string): IniKeyDef[] {
  const lines = body.split('\n');
  const defs: IniKeyDef[] = [];
  let current: IniKeyDef | undefined;
  const bulletRe = /^\*\s+`([A-Za-z_][A-Za-z0-9_]*)\s*=([^`]*)`\s*-?\s*(.*)$/;

  const finalize = (): void => {
    if (current) {
      current.docMd = adocToMarkdown((current.doc ?? '').trim());
      defs.push(current);
    }
  };

  for (const line of lines) {
    const m = bulletRe.exec(line);
    if (m) {
      finalize();
      let rest = stripMacros(m[3]);
      let type: string | undefined;
      const typeM = /^\(([^)]+)\)\s*(.*)$/.exec(rest);
      if (typeM && (type = normalizeType(typeM[1]))) {
        rest = typeM[2];
      }
      current = {
        key: m[1],
        example: m[2].trim() || undefined,
        type,
        doc: stripMacros(rest),
      };
    } else if (current && /^\s+\S/.test(line)) {
      // continuation of the current bullet's description
      current.doc = `${current.doc ?? ''} ${stripMacros(line.trim())}`;
    } else if (current && line.trim() === '') {
      finalize();
      current = undefined;
    }
  }
  finalize();
  return defs;
}

/** Parse `ini-homing.adoc` into per-key rendered markdown. */
export function extractHoming(adoc: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sections = splitSections(adoc, 3);
  for (const [heading, body] of sections) {
    if (/^[A-Z][A-Z0-9_]*$/.test(heading.trim())) {
      out[heading.trim()] = adocToMarkdown(body);
    }
  }
  return out;
}

function stripMacros(s: string): string {
  return s.replace(/\(\(\((?:[^()]|\([^()]*\))*\)\)\)/g, '').trim();
}

/** Only treat a leading `(...)` as a type annotation when it is a recognized
 *  type token — avoids capturing parentheticals like `(Default: 0)` as a type.
 *  Returns the normalized type, or undefined if not a type. */
function normalizeType(raw: string): string | undefined {
  const t = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    bool: 'bool', boolean: 'bool',
    int: 'int', integer: 'int',
    real: 'real', float: 'real', number: 'real',
    string: 'string', text: 'string',
    enum: 'enum',
    u32: 'u32', u64: 'u64', s32: 's32', s64: 's64', bit: 'bit',
  };
  return map[t];
}

function firstParagraph(body: string): string {
  const lines = body.split('\n');
  const para: string[] = [];
  for (const line of lines) {
    if (line.startsWith('*') || line.startsWith('=')) break;
    if (line.trim() === '' && para.length) break;
    if (line.trim()) para.push(line);
  }
  return para.join('\n');
}
