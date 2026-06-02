// Filesystem path/URI canonicalization shared by the workspace index
// (project.ts) and the invariant fuzzer (scripts/fuzz/monorepo-invariants.ts).
// Kept in ONE place so the fuzzer can never drift from the resolver it verifies.
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

/** Canonicalize a filesystem path: dereference symlinks and, on case-insensitive
 *  case-preserving filesystems (macOS, Windows), recover the true on-disk casing.
 *  This mirrors the interpreter, which realpaths its search dirs, and keeps the
 *  resolver and the workspace index in agreement. Falls back to a normalized path
 *  when the target does not exist (e.g. an open, never-saved document). */
export function canonPath(p: string): string {
  try {
    // `.native` calls the OS realpath, which (unlike the JS implementation) also
    // recovers the true on-disk casing on case-insensitive volumes — so a call to
    // o<Probe> against an on-disk probe.ngc yields the same URI the index stored.
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Canonicalize a FILE path: fully canonicalize the directory (dereference dir
 *  symlinks + recover true casing) but DO NOT dereference a final-component
 *  symlink. A subroutine .ngc that is itself a symlink stays at the in-scope
 *  location where the search found it, rather than jumping to its target dir
 *  (which may be outside the config) — keeping go-to-definition and
 *  find-references in agreement. The directory is still canonicalized so a
 *  symlinked search *dir* and the resolver agree (and casing is fixed). */
export function canonFile(fsPath: string): string {
  const dir = path.dirname(fsPath);
  const base = path.basename(fsPath);
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch {
    return path.resolve(fsPath);
  }
  try {
    const entries = fs.readdirSync(realDir);
    const cased = entries.includes(base) ? base : entries.find((e) => e.toLowerCase() === base.toLowerCase());
    return path.join(realDir, cased ?? base);
  } catch {
    return path.join(realDir, base);
  }
}

/** Canonicalize a file URI via {@link canonFile} (returns the input unchanged if
 *  it is not a parseable file URI). */
export function canonicalizeUri(uri: string): string {
  try {
    return URI.file(canonFile(URI.parse(uri).fsPath)).toString();
  } catch {
    return uri;
  }
}

/** True when `child` is `parent` itself or a path nested beneath it. Avoids the
 *  `/a/b` vs `/a/bc` prefix-match trap by going through path.relative. */
export function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
