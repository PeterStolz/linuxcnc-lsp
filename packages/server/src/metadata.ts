import * as fs from 'fs';
import * as path from 'path';
import {
  MetadataIndex, loadDBFromFile, parseCompFile, compToComponentDef, ComponentDef,
} from '@linuxcnc/metadata';

/** Locate the bundled (or override) metadata DB JSON. */
function resolveDbPath(settingsPath?: string): string | undefined {
  const candidates = [
    settingsPath || undefined,
    path.join(__dirname, 'db.json'), // bundled next to server.js
    path.resolve(__dirname, '../../metadata/data/db.json'), // dev (tsc layout)
    path.resolve(__dirname, '../data/db.json'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function loadMetadata(settingsPath?: string): MetadataIndex | undefined {
  const dbPath = resolveDbPath(settingsPath);
  if (!dbPath) return undefined;
  try {
    return loadDBFromFile(dbPath);
  } catch {
    return undefined;
  }
}

/** Recursively find workspace `.comp` files (bounded depth) for the overlay. */
export function scanWorkspaceComps(roots: string[], maxDepth = 4): ComponentDef[] {
  const out: ComponentDef[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.comp')) {
        try {
          const parsed = parseCompFile(fs.readFileSync(p, 'utf8'));
          if (parsed && !seen.has(parsed.name)) {
            seen.add(parsed.name);
            out.push(compToComponentDef(parsed));
          }
        } catch {
          /* ignore unreadable/invalid */
        }
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}
