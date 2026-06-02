import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parseHal, parseIni, LineIndex, findSection, findEntries } from '@linuxcnc/core';
import {
  MetadataIndex, buildMachineModel, MachineModel, HalFileInput, IniFileInput,
} from '@linuxcnc/metadata';
import { canonPath, canonFile, canonicalizeUri, isUnder } from './paths';
import { GCODE_EXTENSIONS } from './gcodeFiles';

interface ResolvedHal {
  uri: string;
  phase: 'pre' | 'postgui' | 'shutdown';
  order: number;
  opaque: boolean; // Tcl or unresolved LIB: file
}

/** Default max directory depth for the workspace scan. The single source of truth
 *  — the server's `linuxcnc.scan.maxDepth` setting falls back to this, and the
 *  constructor default matches it so a `new Project(...)` in a test indexes to the
 *  same depth as production. Keep `packages/client/package.json` in sync. */
export const DEFAULT_SCAN_DEPTH = 8;

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
  /** Canonical (realpath'd) directory of each indexed INI, cached so the
   *  per-keystroke ownership lookup doesn't realpath every INI on every call. */
  private iniCanonDir = new Map<string, string>();

  constructor(
    private readonly getText: (uri: string) => string | undefined,
    private readonly libDir: () => string | undefined,
    /** Max directory depth for the workspace scan (configurable via
     *  `linuxcnc.scan.maxDepth`); deep monorepos need more than the default. */
    private readonly maxDepth: () => number = () => DEFAULT_SCAN_DEPTH,
  ) {}

  /** Scan workspace roots for .ini and .ngc files and (re)build associations. */
  scanRoots(roots: string[]): void {
    this.iniToHal.clear();
    this.halToInis.clear();
    this.iniToSubDirs.clear();
    this.ngcByBasename.clear();
    this.iniCanonDir.clear();
    const depth = this.maxDepth();
    for (const root of roots) {
      // One combined walk per root collecting .ini AND every G-code extension —
      // .nc/.tap/.gcode callers must be indexed too, else find-references and the
      // basename fallback silently miss them until the file is opened.
      const { inis, gcode } = scanProjectFiles(root, depth);
      for (const iniPath of inis) this.indexIni(URI.file(iniPath).toString());
      // The walk already realpath'd each directory and used the true on-disk
      // casing, so these paths are canonical — skip the per-file realpath+readdir
      // (which is otherwise O(n^2) for a flat dir of thousands of subs).
      for (const ngcPath of gcode) this.addCanonicalNgc(URI.file(ngcPath).toString());
    }
  }

  /** Add a .ngc file to the basename index (for cross-file subroutine lookup).
   *  Stored canonical (symlink-dereferenced, true-cased) so it matches what the
   *  resolver returns. */
  indexNgc(ngcUri: string): void {
    this.addCanonicalNgc(canonicalizeUri(ngcUri));
  }

  /** Add an ALREADY-CANONICAL .ngc URI to the basename index. */
  private addCanonicalNgc(uri: string): void {
    const base = this.ngcBaseName(uri);
    if (!base) return;
    const list = this.ngcByBasename.get(base) ?? [];
    if (!list.includes(uri)) list.push(uri);
    this.ngcByBasename.set(base, list);
  }

  /** Drop a .ngc file from the basename index (file deleted on disk). On delete the
   *  path can no longer be canonicalized (realpath/readdir fail on the missing
   *  file), so the stored *canonical* key is unreachable when the file sat under a
   *  symlinked ancestor or had on-disk casing differing from the delivered path.
   *  Rather than re-deriving that key, prune the basename bucket of the
   *  (re-)canonicalized URI AND of any entry whose file no longer exists — robust
   *  to symlinks/casing and self-healing. */
  removeNgc(ngcUri: string): void {
    const base = this.ngcBaseName(ngcUri); // basename is fs-free; works on the raw URI
    if (!base) return;
    const list = this.ngcByBasename.get(base);
    if (!list) return;
    const canon = canonicalizeUri(ngcUri);
    const kept = list.filter((u) => u !== canon && fileExistsCased(u));
    if (kept.length) this.ngcByBasename.set(base, kept);
    else this.ngcByBasename.delete(base);
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

  /** The union of subroutine search-path dirs across all indexed INIs, sorted so
   *  the global (no-config) resolver is order-independent — its result can't flip
   *  on INI-insertion / scan order. */
  subroutineDirs(): string[] {
    const set = new Set<string>();
    for (const dirs of this.iniToSubDirs.values()) for (const d of dirs) set.add(d);
    return [...set].sort();
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
    // Sort so a same-basename collision resolves deterministically (not by
    // index-insertion order), matching the tie-break in iniOwnersForNgc.
    return ws && ws.length ? [...ws].sort()[0] : undefined;
  }

  /** Resolve a named subroutine using ONLY a single config's ordered search dirs.
   *  There is no global union and no basename fallback, so a call cannot bleed into
   *  another machine's subroutine. Search order: the caller's own directory first,
   *  then the config's dirs in interpreter order (PROGRAM_PREFIX before
   *  SUBROUTINES), first occurrence wins.
   *
   *  NOTE: the interpreter's find_ngc_file (rs274ngc_pre.cc) does NOT search the
   *  calling program's own directory — it searches PROGRAM_PREFIX then SUBROUTINES.
   *  The own-dir probe here is a deliberate, more-permissive editor convenience (a
   *  sub sitting beside its caller resolves for navigation), so it can resolve a
   *  call the interpreter would not when the sub exists only in the own dir and not
   *  on the declared search path. */
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

  /** Resolve a named subroutine for `fromUri`, choosing scoped vs global resolution
   *  by whether an indexed config owns the file. The single entry point so callers
   *  (and the invariant fuzzer) never re-assemble the `owner ? scoped : global`
   *  branch. */
  resolveSubroutine(fromUri: string, name: string, activeIni?: string): string | undefined {
    return this.resolveInScope(fromUri, name, this.subroutineScope(fromUri, activeIni));
  }

  /** Resolve against an already-computed scope (hot loops compute the scope once
   *  and reuse it across many calls). */
  resolveInScope(
    fromUri: string, name: string, scope: { ownerIni?: string; searchDirs: string[] },
  ): string | undefined {
    return scope.ownerIni
      ? this.resolveSubroutineScoped(fromUri, name, scope.searchDirs)
      : this.resolveSubroutineFile(fromUri, name);
  }

  /** The find-references / rename universe for `fromUri`: the .ngc under the owning
   *  config's roots when a config owns it, else the whole workspace.
   *
   *  A file under this config's roots may actually belong to a TIGHTER config (a
   *  nested sub-config, or another INI sharing the dir): its own dir is enclosed by
   *  this config's, but a deeper INI owns it. find-references and rename MUST NOT
   *  reach into another machine's subroutines, so such files are excluded — only
   *  files this same config owns (plus files owned by no config, e.g. a shared
   *  library on the search path) stay. Without this, renaming an o-word could
   *  silently rewrite a different machine's .ngc files. */
  referencesUniverse(fromUri: string, activeIni?: string): string[] {
    const scope = this.subroutineScope(fromUri, activeIni);
    if (!scope.ownerIni) return this.workspaceNgcUris();
    return this.ngcUrisUnderRoots(scope.universeRoots).filter((u) => {
      const owners = this.iniOwnersForNgc(u);
      return owners.length === 0 || pickMachine(owners, activeIni) === scope.ownerIni;
    });
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
      if (this.fileResolvable(fsPath)) {
        return URI.file(canonFile(fsPath)).toString();
      }
    }
    return undefined;
  }

  /** Does `<fsPath>` exist as a subroutine file? An open buffer counts; otherwise
   *  a stat — so we never read a whole .ngc just to test existence, and a huge
   *  file or a directory is correctly not treated as a resolvable subroutine. */
  private fileResolvable(fsPath: string): boolean {
    if (this.getText(URI.file(fsPath).toString()) !== undefined) return true;
    try {
      return fs.statSync(fsPath).isFile();
    } catch {
      return false;
    }
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
      this.iniCanonDir.delete(iniUri);
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
    // Cache the INI's canonical dir so ownership lookups don't realpath it again.
    const iniDir = this.ownDirOf(iniUri);
    if (iniDir !== undefined) this.iniCanonDir.set(iniUri, canonPath(iniDir));
  }

  /** Drop an INI from the index (file deleted on disk). The delete event's URI may
   *  not string-match the indexed key (symlinked ancestor / casing), so fall back
   *  to dropping any indexed INI of the same basename that no longer exists. */
  removeIni(iniUri: string): void {
    if (this.iniToHal.has(iniUri)) { this.dropIni(iniUri); return; }
    const base = this.iniBaseName(iniUri);
    if (base === undefined) return;
    for (const key of [...this.iniToHal.keys()]) {
      if (this.iniBaseName(key) === base && !fileExistsCased(key)) this.dropIni(key);
    }
  }

  private dropIni(iniUri: string): void {
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
    this.iniCanonDir.delete(iniUri);
  }

  private iniBaseName(iniUri: string): string | undefined {
    try {
      return path.basename(URI.parse(iniUri).fsPath).toLowerCase();
    } catch {
      return undefined;
    }
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
      const iniDir = this.iniCanonDir.get(iniUri); // cached; no realpath per INI per call
      if (iniDir === undefined || !isUnder(ngcDir, iniDir)) continue;
      if (iniDir.length > best) {
        best = iniDir.length;
        owners = [iniUri];
      } else if (iniDir.length === best) {
        owners.push(iniUri);
      }
    }
    // Sort tied owners (same enclosing dir) so the pick is deterministic when
    // activeMachine is unset — resolution can't flip on Map-iteration/save order.
    return owners.length > 1 ? owners.sort() : owners;
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
      const dir = this.ownDirOf(uri); // stored URIs are canonical -> no realpath needed
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

/** True when a file with the EXACT casing of `uri`'s basename currently exists in
 *  its directory. Used to prune the index on delete events. Unlike fs.existsSync
 *  (case-insensitive on macOS/Windows, so it reports a stale `Probe.ngc` as still
 *  present after a rename to `probe.ngc`), this reads the directory and checks for
 *  the exact name — so a case-only rename correctly prunes the old-cased entry
 *  instead of leaving a wrong-cased ghost in the index. A missing directory
 *  (readdir throws) reads as "gone", matching the deleted-file intent. */
function fileExistsCased(uri: string): boolean {
  try {
    const fsPath = URI.parse(uri).fsPath;
    return fs.readdirSync(path.dirname(fsPath)).includes(path.basename(fsPath));
  } catch {
    return false;
  }
}

/** One depth-bounded walk of `root` collecting both `.ini` files and every G-code
 *  file (any GCODE_EXTENSIONS, case-insensitive). Symlinked directories are
 *  followed (a SUBROUTINES dir is often a symlink) and de-duped by realpath so a
 *  symlink cycle cannot loop and a shared tree is walked once. */
function scanProjectFiles(root: string, maxDepth: number): { inis: string[]; gcode: string[] } {
  const inis: string[] = [];
  const gcode: string[] = [];
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
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) { walk(p, depth + 1); continue; }
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.ini')) inis.push(p);
      // `real` is the realpath of the containing dir and `e.name` is the true
      // on-disk casing, so `real/e.name` is already the canonical file path
      // (matches canonFile without re-statting per file).
      else if (GCODE_EXTENSIONS.some((ext) => lower.endsWith(ext))) gcode.push(path.join(real, e.name));
    }
  };
  walk(root, 0);
  return { inis, gcode };
}
