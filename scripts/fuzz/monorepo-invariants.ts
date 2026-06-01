// Invariant checker for multi-machine G-code subroutine scoping. Given a
// workspace root containing one or more LinuxCNC machine configs, it builds a
// Project (the language server's index), enumerates every named o<...> call in
// every indexed .ngc/.nc/.tap/.gcode file, and verifies the per-config scoping
// invariants. Used by the fuzz campaign: agents generate weird config trees and
// run this to find violations.
//
//   pnpm exec tsx scripts/fuzz/monorepo-invariants.ts <workspaceRoot>
//
// Prints JSON: { root, indexedNgc, namedCalls, ownedCalls, violations: [...] }.
// Exit code 2 if any violation is found, 0 otherwise, 3 on harness error.
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parseGcode } from '@linuxcnc/core';
import { Project } from '../../packages/server/src/project';
// Reuse the SERVER's canonicalization + containment helpers so the invariant
// checker can never drift from the resolver it is verifying.
import { canonPath, isUnder } from '../../packages/server/src/paths';

export interface Violation {
  inv: string;
  caller: string;
  name?: string;
  detail: string;
}

const GCODE_EXTS = ['.ngc', '.nc', '.tap', '.gcode'];

/** Is `<name>.ngc` (or its lowercased form) a readable file in `dir`? Mirrors
 *  Project.tryDir's readText semantics (a file that cannot be read does not
 *  count as resolvable). */
function readableSub(dir: string, name: string): boolean {
  const lower = name.toLowerCase();
  const candidates = name === lower ? [name + '.ngc'] : [name + '.ngc', lower + '.ngc'];
  for (const c of candidates) {
    try {
      fs.readFileSync(path.join(dir, c), 'utf8');
      return true;
    } catch {
      /* not readable here */
    }
  }
  return false;
}

export function checkWorkspace(root: string, maxDepth = 8): {
  indexedNgc: number;
  namedCalls: number;
  ownedCalls: number;
  violations: Violation[];
} {
  const violations: Violation[] = [];
  const project = new Project(() => undefined, () => undefined, () => maxDepth);
  project.scanRoots([root]);

  // A second project built by indexing files in REVERSED discovery order, to
  // catch order-dependent (nondeterministic) resolution.
  const reversed = new Project(() => undefined, () => undefined, () => maxDepth);
  const allFiles = walkAll(root, maxDepth);
  for (const f of [...allFiles].reverse()) {
    const uri = URI.file(f).toString();
    if (f.toLowerCase().endsWith('.ini')) reversed.indexIni(uri);
    else reversed.indexNgc(uri);
  }

  const callers = project.workspaceNgcUris();
  let namedCalls = 0;
  let ownedCalls = 0;

  const resolveIn = (proj: Project, callerUri: string, name: string): string | undefined =>
    proj.resolveSubroutine(callerUri, name);

  for (const callerUri of callers) {
    let callerPath: string;
    try {
      callerPath = URI.parse(callerUri).fsPath;
    } catch {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(callerPath, 'utf8');
    } catch {
      continue;
    }
    const prog = parseGcode(text);
    const ownDir = path.dirname(callerPath);
    const names = new Set<string>();
    for (const st of prog.statements) {
      if (st.keyword !== 'call') continue;
      if (st.oword.form !== 'named' || !st.oword.name) continue;
      names.add(st.oword.name);
    }
    for (const name of names) {
      namedCalls++;
      const scope = project.subroutineScope(callerUri);
      const scoped = project.resolveInScope(callerUri, name, scope);

      if (!scope.ownerIni) continue; // loose file -> global fallback, not scoped
      ownedCalls++;

      const allowedDirs = [ownDir, ...scope.searchDirs].map(canonPath).filter((d): d is string => !!d);

      // INV1: a scoped resolution must live in the caller's own dir or one of the
      // owning config's declared search dirs — never another config's private dir.
      if (scoped) {
        let resPath: string;
        try {
          resPath = URI.parse(scoped).fsPath;
        } catch {
          resPath = '';
        }
        const resDir = canonPath(path.dirname(resPath));
        if (!resDir || !allowedDirs.includes(resDir)) {
          violations.push({
            inv: 'INV1-bleed',
            caller: callerPath,
            name,
            detail: `resolved to ${resPath} whose dir is not in the owning config's search path [${allowedDirs.join(', ')}]`,
          });
        }
      }

      // INV6: if a readable <name>.ngc exists in the caller's own dir or a declared
      // search dir, scoped resolution must NOT be undefined (no false-negative).
      // A name containing a path separator is deliberately unresolvable (the server
      // refuses o<../../other> to prevent traversal), so it is exempt.
      const isPathy = name.includes('/') || name.includes('\\');
      const existsInScope = !isPathy && [ownDir, ...scope.searchDirs].some((d) => readableSub(d, name));
      if (existsInScope && !scoped) {
        violations.push({
          inv: 'INV6-false-negative',
          caller: callerPath,
          name,
          detail: `a readable ${name}.ngc exists in scope but scoped resolution returned undefined`,
        });
      }

      // INV3: the find-references universe (the product method, which also excludes
      // files a tighter nested config owns) must be bounded by the config roots and
      // must include the resolved definition (else references would miss it).
      const universe = project.referencesUniverse(callerUri);
      const rootCanons = scope.universeRoots.map(canonPath).filter((d): d is string => !!d);
      for (const u of universe) {
        let up: string;
        try {
          up = URI.parse(u).fsPath;
        } catch {
          continue;
        }
        const uDir = canonPath(path.dirname(up));
        if (uDir && !rootCanons.some((r) => isUnder(uDir, r))) {
          violations.push({
            inv: 'INV3-universe-unbounded',
            caller: callerPath,
            name,
            detail: `reference universe includes ${up} outside the config roots [${rootCanons.join(', ')}]`,
          });
          break;
        }
      }
      // INV3-def-missing only applies when the resolved def is actually INDEXED
      // (within the scanned tree). A def resolved straight off disk but outside the
      // index (declared dir beyond scan maxDepth, or an absolute path outside the
      // workspace) is a known coverage limit, not a scoping bug — go-to-def works,
      // find-references is intentionally scoped to indexed files.
      if (scoped) {
        const indexed = project.workspaceNgcUris();
        const inIndex = indexed.includes(scoped);
        if (inIndex && !universe.includes(scoped)) {
          violations.push({
            inv: 'INV3-def-missing',
            caller: callerPath,
            name,
            detail: `the resolved definition ${scoped} is indexed but not in the find-references universe`,
          });
        }
      }

      // INV2: resolution must be order-independent unless the caller is enclosed by
      // more than one INI in the same directory (a genuine tie needing activeMachine).
      const owners = project.iniOwnersForNgc(callerUri);
      const isTie = owners.length > 1;
      if (!isTie) {
        const a = scoped;
        const b = resolveIn(reversed, callerUri, name);
        if (a !== b) {
          violations.push({
            inv: 'INV2-nondeterministic',
            caller: callerPath,
            name,
            detail: `scan-order changed resolution: ${a} vs ${b} (single owner, should be stable)`,
          });
        }
      }
    }
  }

  return { indexedNgc: callers.length, namedCalls, ownedCalls, violations };
}

function walkAll(root: string, maxDepth: number): string[] {
  // Files of interest for index building: .ini + gcode.
  const out: string[] = [];
  const rec = (dir: string, depth: number): void => {
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
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) rec(p, depth + 1);
      else if (e.name.toLowerCase().endsWith('.ini') || GCODE_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) {
        out.push(p);
      }
    }
  };
  rec(root, 0);
  return out;
}

// CLI entry.
if (require.main === module) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: tsx scripts/fuzz/monorepo-invariants.ts <workspaceRoot>');
    process.exit(3);
  }
  try {
    const res = checkWorkspace(path.resolve(root));
    console.log(JSON.stringify({ root: path.resolve(root), ...res }, null, 2));
    process.exit(res.violations.length ? 2 : 0);
  } catch (err) {
    console.error('HARNESS ERROR:', (err as Error).stack || String(err));
    process.exit(3);
  }
}
