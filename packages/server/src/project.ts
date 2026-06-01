import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parseHal, parseIni, LineIndex, findSection, findEntries } from '@linuxcnc/core';
import {
  MetadataIndex, buildMachineModel, MachineModel, HalFileInput, IniFileInput,
} from '@linuxcnc/metadata';

interface ResolvedHal {
  uri: string;
  phase: 'pre' | 'postgui' | 'shutdown';
  order: number;
  opaque: boolean; // Tcl or unresolved LIB: file
}

/** Tracks INI <-> HAL associations across the workspace and builds machine
 *  models on demand. Reads file contents via `getText` (open docs) falling
 *  back to the filesystem. */
export class Project {
  private iniToHal = new Map<string, ResolvedHal[]>();
  private halToInis = new Map<string, Set<string>>();
  /** Subroutine search-path dirs declared by each INI ([RS274NGC]SUBROUTINES +
   *  [DISPLAY]PROGRAM_PREFIX), resolved to absolute fs paths. */
  private iniToSubDirs = new Map<string, string[]>();
  /** Workspace .ngc files indexed by lowercased basename (no extension) for
   *  file-based subroutine resolution fallback. */
  private ngcByBasename = new Map<string, string[]>();

  constructor(
    private readonly getText: (uri: string) => string | undefined,
    private readonly libDir: () => string | undefined,
    /** Max directory depth for the workspace scan (configurable via
     *  `linuxcnc.scan.maxDepth`); deep monorepos need more than the default. */
    private readonly maxDepth: () => number = () => 5,
  ) {}

  /** Scan workspace roots for .ini and .ngc files and (re)build associations. */
  scanRoots(roots: string[]): void {
    this.iniToHal.clear();
    this.halToInis.clear();
    this.iniToSubDirs.clear();
    this.ngcByBasename.clear();
    const depth = this.maxDepth();
    for (const root of roots) {
      for (const iniPath of findFilesByExt(root, '.ini', depth)) {
        this.indexIni(URI.file(iniPath).toString());
      }
      for (const ngcPath of findFilesByExt(root, '.ngc', depth)) {
        this.indexNgc(URI.file(ngcPath).toString());
      }
    }
  }

  /** Add a .ngc file to the basename index (for cross-file subroutine lookup).
   *  Stored canonical (symlink-dereferenced, true-cased) so it matches what the
   *  resolver returns. */
  indexNgc(ngcUri: string): void {
    const uri = canonicalizeUri(ngcUri);
    const base = this.ngcBaseName(uri);
    if (!base) return;
    const list = this.ngcByBasename.get(base) ?? [];
    if (!list.includes(uri)) list.push(uri);
    this.ngcByBasename.set(base, list);
  }

  /** Drop a .ngc file from the basename index (file deleted on disk). */
  removeNgc(ngcUri: string): void {
    const uri = canonicalizeUri(ngcUri);
    const base = this.ngcBaseName(uri);
    if (!base) return;
    const list = this.ngcByBasename.get(base);
    if (!list) return;
    const i = list.indexOf(uri);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.ngcByBasename.delete(base);
  }

  /** Canonical form of a file URI (symlink-dereferenced, true-cased), matching how
   *  indexed and resolved URIs are stored — used to compare URIs across the
   *  index/resolver boundary. */
  canonicalUri(uri: string): string {
    return canonicalizeUri(uri);
  }

  private ngcBaseName(ngcUri: string): string | undefined {
    let fsPath: string;
    try {
      fsPath = URI.parse(ngcUri).fsPath;
    } catch {
      return undefined;
    }
    return path.basename(fsPath, path.extname(fsPath)).toLowerCase() || undefined;
  }

  /** Every workspace .ngc URI (for cross-file find-references). */
  workspaceNgcUris(): string[] {
    const out: string[] = [];
    for (const arr of this.ngcByBasename.values()) out.push(...arr);
    return out;
  }

  /** The union of subroutine search-path dirs across all indexed INIs. */
  subroutineDirs(): string[] {
    const set = new Set<string>();
    for (const dirs of this.iniToSubDirs.values()) for (const d of dirs) set.add(d);
    return [...set];
  }

  /** Resolve a named subroutine to the .ngc file that defines it, searching the
   *  caller's own directory, the INI search path, then the workspace by
   *  basename. Returns the file URI, or undefined if not found.
   *
   *  This is the GLOBAL (workspace-wide) resolver, kept for files that belong to
   *  no indexed config. Prefer `resolveSubroutineScoped` for a file owned by a
   *  machine config — the global union + basename fallback can otherwise resolve
   *  a call to another machine's identically-named subroutine. */
  resolveSubroutineFile(fromUri: string, name: string): string | undefined {
    const own = this.ownDirOf(fromUri);
    if (own) {
      const hit = this.tryDir(own, name);
      if (hit) return hit;
    }
    for (const d of this.subroutineDirs()) {
      const hit = this.tryDir(d, name);
      if (hit) return hit;
    }
    const ws = this.ngcByBasename.get(name.toLowerCase());
    return ws && ws.length ? ws[0] : undefined;
  }

  /** Resolve a named subroutine using ONLY a single config's ordered search dirs
   *  (the caller's own directory first, then the given dirs in interpreter order:
   *  PROGRAM_PREFIX before SUBROUTINES). There is no global union and no
   *  basename fallback, so a call cannot bleed into another machine's subroutine.
   *  Mirrors the interpreter's find_ngc_file (rs274ngc_pre.cc): per running INI,
   *  flat directory search, first occurrence wins. */
  resolveSubroutineScoped(fromUri: string, name: string, searchDirs: string[]): string | undefined {
    const own = this.ownDirOf(fromUri);
    if (own) {
      const hit = this.tryDir(own, name);
      if (hit) return hit;
    }
    for (const d of searchDirs) {
      const hit = this.tryDir(d, name);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Look for `<name>.ngc` (and a lowercased variant) in a single directory,
   *  returning the CANONICAL URI of the file that actually exists (symlink
   *  dereferenced, true on-disk casing) so it matches the workspace index and
   *  go-to-definition does not open a phantom differently-cased document.
   *
   *  A subroutine name may not contain a path separator: `o<../../other/sub>`
   *  would otherwise let path.join escape the config's declared search dirs and
   *  resolve into a different machine. Such names never resolve. */
  private tryDir(dir: string, name: string): string | undefined {
    if (name.includes('/') || name.includes('\\')) return undefined;
    const lower = name.toLowerCase();
    for (const fname of name === lower ? [name + '.ngc'] : [name + '.ngc', lower + '.ngc']) {
      const fsPath = path.join(dir, fname);
      if (this.readText(URI.file(fsPath).toString()) !== undefined) {
        return URI.file(canonFile(fsPath)).toString();
      }
    }
    return undefined;
  }

  private ownDirOf(fromUri: string): string | undefined {
    try {
      return path.dirname(URI.parse(fromUri).fsPath);
    } catch {
      return undefined;
    }
  }

  /** Read a file's text (open document, else from disk). Exposed for the server's
   *  cross-file G-code analysis. */
  readFileText(uri: string): string | undefined {
    return this.readText(uri);
  }

  /** (Re)index a single INI file's [HAL] section. */
  indexIni(iniUri: string): void {
    // drop old associations for this ini
    const old = this.iniToHal.get(iniUri);
    if (old) for (const h of old) this.halToInis.get(h.uri)?.delete(iniUri);

    const text = this.readText(iniUri);
    if (text === undefined) {
      this.iniToHal.delete(iniUri);
      this.iniToSubDirs.delete(iniUri);
      return;
    }
    const ini = parseIni(text);
    this.indexSubDirs(iniUri, ini);
    const hal = findSection(ini, 'HAL');
    const resolved: ResolvedHal[] = [];
    if (hal) {
      let order = 0;
      const add = (value: string, phase: ResolvedHal['phase']) => {
        const r = this.resolveHalfile(iniUri, value);
        if (r) resolved.push({ uri: r.uri, phase, order: order++, opaque: r.opaque });
      };
      for (const e of findEntries(hal, 'HALFILE')) if (e.value) add(e.value.text, 'pre');
      for (const e of findEntries(hal, 'POSTGUI_HALFILE')) if (e.value) add(e.value.text, 'postgui');
      for (const e of findEntries(hal, 'SHUTDOWN')) if (e.value) add(e.value.text, 'shutdown');
    }
    this.iniToHal.set(iniUri, resolved);
    for (const h of resolved) {
      let set = this.halToInis.get(h.uri);
      if (!set) this.halToInis.set(h.uri, (set = new Set()));
      set.add(iniUri);
    }
  }

  /** Drop an INI from the index (file deleted on disk). */
  removeIni(iniUri: string): void {
    const old = this.iniToHal.get(iniUri);
    if (old) {
      for (const h of old) {
        const set = this.halToInis.get(h.uri);
        if (set) {
          set.delete(iniUri);
          if (!set.size) this.halToInis.delete(h.uri);
        }
      }
    }
    this.iniToHal.delete(iniUri);
    this.iniToSubDirs.delete(iniUri);
  }

  /** INIs that include the given HAL file (may be empty for orphan files). */
  machinesForHal(halUri: string): string[] {
    return [...(this.halToInis.get(halUri) ?? [])];
  }

  allIniUris(): string[] {
    return [...this.iniToHal.keys()];
  }

  /** The single INI's resolved subroutine search dirs, in interpreter order
   *  (PROGRAM_PREFIX, then each SUBROUTINES entry), absolute. */
  subDirsForIni(iniUri: string): string[] {
    return this.iniToSubDirs.get(iniUri) ?? [];
  }

  /** The indexed INI(s) whose own directory most tightly encloses `ngcUri` (the
   *  deepest ancestor directory). Several INIs sharing that directory are all
   *  returned. Empty when no indexed INI is an ancestor — callers then fall back
   *  to global (workspace-wide) behavior. */
  iniOwnersForNgc(ngcUri: string): string[] {
    const ngcDir = this.canonDirOf(ngcUri);
    if (ngcDir === undefined) return [];
    let best = -1;
    let owners: string[] = [];
    for (const iniUri of this.iniToHal.keys()) {
      const iniDir = this.canonDirOf(iniUri);
      if (iniDir === undefined || !isUnder(ngcDir, iniDir)) continue;
      if (iniDir.length > best) {
        best = iniDir.length;
        owners = [iniUri];
      } else if (iniDir.length === best) {
        owners.push(iniUri);
      }
    }
    return owners;
  }

  /** Compute the subroutine-resolution scope for a G-code file: the owning config
   *  (honoring the active-machine pin when several configs enclose the file), that
   *  config's ordered search dirs, and the roots that bound find-references. When
   *  no config owns the file, `ownerIni` is undefined and callers fall back to the
   *  global resolver / whole-workspace reference scan. */
  subroutineScope(
    ngcUri: string,
    activeIni?: string,
  ): { ownerIni?: string; searchDirs: string[]; universeRoots: string[] } {
    const owners = this.iniOwnersForNgc(ngcUri);
    const ownerIni = pickMachine(owners, activeIni);
    if (!ownerIni) return { searchDirs: [], universeRoots: [] };
    const searchDirs = this.subDirsForIni(ownerIni);
    const iniDir = this.iniDirOf(ownerIni);
    const universeRoots = iniDir ? [iniDir, ...searchDirs] : [...searchDirs];
    return { ownerIni, searchDirs, universeRoots };
  }

  /** Workspace .ngc URIs whose directory lies within one of `roots` (a config's
   *  own dir and its declared subroutine dirs). The scoped universe for
   *  find-references; empty roots -> empty (caller falls back to the workspace). */
  ngcUrisUnderRoots(roots: string[]): string[] {
    if (!roots.length) return [];
    const canonRoots = roots.map(canonPath);
    const out: string[] = [];
    for (const uri of this.workspaceNgcUris()) {
      const dir = this.canonDirOf(uri);
      if (dir !== undefined && canonRoots.some((r) => isUnder(dir, r))) out.push(uri);
    }
    return out;
  }

  private iniDirOf(iniUri: string): string | undefined {
    return this.ownDirOf(iniUri);
  }

  /** The canonical (realpath) directory containing a file URI. */
  private canonDirOf(uri: string): string | undefined {
    const d = this.ownDirOf(uri);
    return d === undefined ? undefined : canonPath(d);
  }

  /** Build a machine model for an INI, parsing all member HAL files. */
  buildModel(iniUri: string, index: MetadataIndex): MachineModel | undefined {
    const resolved = this.iniToHal.get(iniUri);
    if (!resolved) return undefined;
    const iniText = this.readText(iniUri);
    const iniInput: IniFileInput | undefined = iniText !== undefined
      ? { uri: iniUri, lineIndex: new LineIndex(iniText), ini: parseIni(iniText) }
      : undefined;

    // Resolve #INCLUDE-d INI files (relative to the including file's dir) so that
    // [SECTION]KEY refs defined in an .inc resolve and don't false-positive.
    const iniIncludes: IniFileInput[] = [];
    if (iniInput) {
      const seen = new Set<string>([iniUri]);
      const collect = (baseUri: string, ini: ReturnType<typeof parseIni>): void => {
        const baseDir = path.dirname(URI.parse(baseUri).fsPath);
        for (const inc of ini.includes) {
          const v = inc.file.text.trim();
          if (!v) continue;
          const abs = path.isAbsolute(v) ? v : path.join(baseDir, v);
          const incUri = URI.file(abs).toString();
          if (seen.has(incUri)) continue; // guard against #INCLUDE cycles
          seen.add(incUri);
          const text = this.readText(incUri);
          if (text === undefined) continue;
          const parsed = parseIni(text);
          iniIncludes.push({ uri: incUri, lineIndex: new LineIndex(text), ini: parsed });
          if (iniIncludes.length < 64) collect(incUri, parsed); // bounded
        }
      };
      collect(iniUri, iniInput.ini);
    }

    const files: HalFileInput[] = [];
    let hasOpaque = false;
    for (const r of resolved) {
      if (r.opaque || r.uri.endsWith('.tcl')) {
        hasOpaque = true;
        continue;
      }
      const text = this.readText(r.uri);
      if (text === undefined) continue;
      files.push({ uri: r.uri, text, lineIndex: new LineIndex(text), hal: parseHal(text), phase: r.phase, order: r.order });
    }
    return buildMachineModel({ iniInput, iniIncludes, files, index, hasOpaqueFiles: hasOpaque });
  }

  /** Record the subroutine search-path dirs declared by an INI. */
  private indexSubDirs(iniUri: string, ini: ReturnType<typeof parseIni>): void {
    let iniDir: string;
    try {
      iniDir = path.dirname(URI.parse(iniUri).fsPath);
    } catch {
      this.iniToSubDirs.delete(iniUri);
      return;
    }
    const dirs: string[] = [];
    const add = (v: string): void => {
      const t = v.trim();
      if (t) dirs.push(path.isAbsolute(t) ? t : path.join(iniDir, t));
    };
    // Order mirrors the interpreter's find_ngc_file (rs274ngc_pre.cc): a named
    // subroutine is searched for in [DISPLAY]PROGRAM_PREFIX *first*, then the
    // [RS274NGC]SUBROUTINES list, first occurrence wins. (USER_M_PATH is
    // deliberately excluded: it is searched only for user M-codes, not o-word
    // subroutine .ngc files.)
    const disp = findSection(ini, 'DISPLAY');
    if (disp) {
      for (const e of findEntries(disp, 'PROGRAM_PREFIX')) if (e.value) add(e.value.text);
    }
    const rs = findSection(ini, 'RS274NGC');
    if (rs) {
      // SUBROUTINES is a colon-separated list of directories.
      for (const e of findEntries(rs, 'SUBROUTINES')) {
        if (e.value) for (const part of e.value.text.split(':')) add(part);
      }
    }
    this.iniToSubDirs.set(iniUri, dirs);
  }

  private resolveHalfile(iniUri: string, value: string): { uri: string; opaque: boolean } | undefined {
    const v = value.trim().split(/\s+/)[0]; // strip trailing args (tcl files can have args)
    if (!v) return undefined;
    if (v.startsWith('LIB:')) {
      const lib = this.libDir();
      if (!lib) return { uri: URI.file('/__lib__/' + v.slice(4)).toString(), opaque: true };
      return { uri: URI.file(path.join(lib, v.slice(4))).toString(), opaque: false };
    }
    const iniDir = path.dirname(URI.parse(iniUri).fsPath);
    const abs = path.isAbsolute(v) ? v : path.join(iniDir, v);
    return { uri: URI.file(abs).toString(), opaque: false };
  }

  private readText(uri: string): string | undefined {
    const open = this.getText(uri);
    if (open !== undefined) return open;
    try {
      return fs.readFileSync(URI.parse(uri).fsPath, 'utf8');
    } catch {
      return undefined;
    }
  }
}

/** Resolve the `linuxcnc.activeMachine` setting (an INI path or file name) to one
 *  of the workspace's indexed INI URIs. Accepts an exact fs-path or a path/name
 *  suffix so the user can write `MachineA.ini`, `subdir/MachineA.ini`, or a full
 *  path. Returns undefined if unset or no match. */
export function resolveActiveMachine(setting: string | undefined, iniUris: string[]): string | undefined {
  if (!setting || !setting.trim()) return undefined;
  const want = setting.trim().replace(/\\/g, '/').toLowerCase();
  let suffixMatch: string | undefined;
  for (const uri of iniUris) {
    let fsPath: string;
    try {
      fsPath = URI.parse(uri).fsPath.replace(/\\/g, '/').toLowerCase();
    } catch {
      continue;
    }
    if (fsPath === want) return uri; // exact path
    if (!suffixMatch && (fsPath.endsWith('/' + want) || fsPath === want)) suffixMatch = uri;
  }
  return suffixMatch;
}

/** Choose the machine that provides context for a HAL file owned by 0..N
 *  machines: the pinned active machine if it owns the file, else the first. */
export function pickMachine(machines: string[], activeUri?: string): string | undefined {
  if (!machines.length) return undefined;
  if (activeUri && machines.includes(activeUri)) return activeUri;
  return machines[0];
}

/** Canonicalize a filesystem path: dereference symlinks and, on case-insensitive
 *  case-preserving filesystems (macOS, Windows), recover the true on-disk casing.
 *  This mirrors the interpreter, which realpaths its search dirs, and keeps the
 *  resolver and the workspace index in agreement. Falls back to a normalized path
 *  when the target does not exist (e.g. an open, never-saved document). */
function canonPath(p: string): string {
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
function canonFile(fsPath: string): string {
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
function canonicalizeUri(uri: string): string {
  try {
    return URI.file(canonFile(URI.parse(uri).fsPath)).toString();
  } catch {
    return uri;
  }
}

/** True when `child` is `parent` itself or a path nested beneath it. Avoids the
 *  `/a/b` vs `/a/bc` prefix-match trap by going through path.relative. */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function findFilesByExt(root: string, ext: string, maxDepth = 5): string[] {
  const out: string[] = [];
  // Track canonical dirs already walked so a symlinked subroutine tree (common in
  // LinuxCNC configs) is indexed exactly once and symlink cycles cannot loop.
  const visited = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    const real = canonPath(dir);
    if (visited.has(real)) return;
    visited.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      // Follow symlinked directories (resolve via stat), not just real dirs, so a
      // SUBROUTINES dir that is a symlink still gets its .ngc files indexed.
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) walk(p, depth + 1);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
