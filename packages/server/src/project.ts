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

  constructor(
    private readonly getText: (uri: string) => string | undefined,
    private readonly libDir: () => string | undefined,
  ) {}

  /** Scan workspace roots for .ini files and (re)build associations. */
  scanRoots(roots: string[]): void {
    this.iniToHal.clear();
    this.halToInis.clear();
    for (const root of roots) {
      for (const iniPath of findIniFiles(root)) {
        this.indexIni(URI.file(iniPath).toString());
      }
    }
  }

  /** (Re)index a single INI file's [HAL] section. */
  indexIni(iniUri: string): void {
    // drop old associations for this ini
    const old = this.iniToHal.get(iniUri);
    if (old) for (const h of old) this.halToInis.get(h.uri)?.delete(iniUri);

    const text = this.readText(iniUri);
    if (text === undefined) {
      this.iniToHal.delete(iniUri);
      return;
    }
    const ini = parseIni(text);
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

function findIniFiles(root: string, maxDepth = 5): string[] {
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
      else if (e.name.endsWith('.ini')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
