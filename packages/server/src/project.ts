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
  ) {}

  /** Scan workspace roots for .ini and .ngc files and (re)build associations. */
  scanRoots(roots: string[]): void {
    this.iniToHal.clear();
    this.halToInis.clear();
    this.iniToSubDirs.clear();
    this.ngcByBasename.clear();
    for (const root of roots) {
      for (const iniPath of findFilesByExt(root, '.ini')) {
        this.indexIni(URI.file(iniPath).toString());
      }
      for (const ngcPath of findFilesByExt(root, '.ngc')) {
        this.indexNgc(URI.file(ngcPath).toString());
      }
    }
  }

  /** Add a .ngc file to the basename index (for cross-file subroutine lookup). */
  indexNgc(ngcUri: string): void {
    let fsPath: string;
    try {
      fsPath = URI.parse(ngcUri).fsPath;
    } catch {
      return;
    }
    const base = path.basename(fsPath, path.extname(fsPath)).toLowerCase();
    if (!base) return;
    const list = this.ngcByBasename.get(base) ?? [];
    if (!list.includes(ngcUri)) list.push(ngcUri);
    this.ngcByBasename.set(base, list);
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
   *  basename. Returns the file URI, or undefined if not found. */
  resolveSubroutineFile(fromUri: string, name: string): string | undefined {
    const lower = name.toLowerCase();
    const tryDir = (dir: string): string | undefined => {
      for (const fname of name === lower ? [name + '.ngc'] : [name + '.ngc', lower + '.ngc']) {
        const uri = URI.file(path.join(dir, fname)).toString();
        if (this.readText(uri) !== undefined) return uri;
      }
      return undefined;
    };
    let ownDir: string | undefined;
    try {
      ownDir = path.dirname(URI.parse(fromUri).fsPath);
    } catch {
      ownDir = undefined;
    }
    if (ownDir) {
      const hit = tryDir(ownDir);
      if (hit) return hit;
    }
    for (const d of this.subroutineDirs()) {
      const hit = tryDir(d);
      if (hit) return hit;
    }
    const ws = this.ngcByBasename.get(lower);
    return ws && ws.length ? ws[0] : undefined;
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

  /** INIs that include the given HAL file (may be empty for orphan files). */
  machinesForHal(halUri: string): string[] {
    return [...(this.halToInis.get(halUri) ?? [])];
  }

  allIniUris(): string[] {
    return [...this.iniToHal.keys()];
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
    const rs = findSection(ini, 'RS274NGC');
    if (rs) {
      // SUBROUTINES is a colon-separated list of directories.
      for (const e of findEntries(rs, 'SUBROUTINES')) {
        if (e.value) for (const part of e.value.text.split(':')) add(part);
      }
    }
    const disp = findSection(ini, 'DISPLAY');
    if (disp) {
      for (const e of findEntries(disp, 'PROGRAM_PREFIX')) if (e.value) add(e.value.text);
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

function findFilesByExt(root: string, ext: string, maxDepth = 5): string[] {
  const out: string[] = [];
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
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
