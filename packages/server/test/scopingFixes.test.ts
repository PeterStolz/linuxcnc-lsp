// Regression tests for the review fixes on top of per-config G-code scoping:
//   M1 — the workspace scan indexes every G-code extension, not just .ngc.
//   M2 — deletion prunes the index even when the delete path can't round-trip
//        canonicalization (symlinked ancestor removed, or differing on-disk casing).
//   S16 — the centralized Project.resolveSubroutine / referencesUniverse API.
//   + GCODE_EXTENSIONS stays in lock-step with the client manifest.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Project, DEFAULT_SCAN_DEPTH } from '../src/project';
import { GCODE_EXTENSIONS, isGcodePath } from '../src/gcodeFiles';

let root: string;
// realpath so expected URIs match the server's canonical (realpath'd) URIs —
// os.tmpdir() is itself a symlink on macOS (/var -> /private/var).
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcnc-fixes-'))); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

function write(rel: string, content: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return URI.file(p).toString();
}
const abs = (rel: string): string => path.join(root, rel);
const uriOf = (rel: string): string => URI.file(abs(rel)).toString();
const baseOf = (uri: string): string => path.basename(URI.parse(uri).fsPath);
const SUB = (name: string): string => `o<${name}> sub\nG1 X1\no<${name}> endsub\n`;
const newProject = (): Project => new Project(() => undefined, () => undefined);

describe('M1: the workspace scan indexes every G-code extension, not just .ngc', () => {
  it('scanRoots indexes .nc/.tap/.gcode callers so find-references can see them', () => {
    write('subs/probe.ngc', SUB('probe'));
    write('caller.ngc', 'o<probe> call\n');
    write('caller.nc', 'o<probe> call\n');
    write('caller.tap', 'o<probe> call\n');
    write('caller.gcode', 'o<probe> call\n');
    const project = newProject();
    project.scanRoots([root]);
    const indexed = project.workspaceNgcUris().map(baseOf).sort();
    expect(indexed).toEqual(['caller.gcode', 'caller.nc', 'caller.ngc', 'caller.tap', 'probe.ngc']);
  });
});

describe('M2: deletion prunes the index even when the path cannot round-trip', () => {
  it('removeNgc drops a ghost when the dir is deleted and the delivered path is a dangling symlink', () => {
    fs.mkdirSync(abs('realsubs'), { recursive: true });
    fs.writeFileSync(abs('realsubs/probe.ngc'), SUB('probe'));
    fs.symlinkSync(abs('realsubs'), abs('link'));
    const project = newProject();
    // Index via the SYMLINK path: canonicalized & stored under realsubs/.
    project.indexNgc(uriOf('link/probe.ngc'));
    expect(project.workspaceNgcUris().length).toBe(1);
    // Remove the real dir entirely; the symlink now dangles so realpath fails and
    // canonicalization can no longer reproduce the stored key.
    fs.rmSync(abs('realsubs'), { recursive: true, force: true });
    project.removeNgc(uriOf('link/probe.ngc'));
    expect(project.workspaceNgcUris()).toEqual([]);
  });

  it('removeNgc drops an entry indexed under different on-disk casing', () => {
    const stored = write('subs/Probe.ngc', SUB('probe')); // on-disk casing 'Probe'
    const project = newProject();
    project.indexNgc(stored);
    expect(project.workspaceNgcUris().length).toBe(1);
    fs.rmSync(abs('subs/Probe.ngc'), { force: true });
    // Deliver the delete with a lowercased path that won't realpath back to 'Probe'.
    project.removeNgc(uriOf('subs/probe.ngc'));
    expect(project.workspaceNgcUris()).toEqual([]);
  });

  it('removeIni drops a machine even when the delete URI casing differs', () => {
    const ini = write('cfg/Machine.ini', '[HAL]\nHALFILE = m.hal\n');
    write('cfg/m.hal', 'loadrt foo\n');
    const project = newProject();
    project.indexIni(ini);
    expect(project.allIniUris().length).toBe(1);
    fs.rmSync(abs('cfg/Machine.ini'), { force: true });
    project.removeIni(uriOf('cfg/machine.ini')); // different casing than indexed
    expect(project.allIniUris()).toEqual([]);
  });

  it('removeNgc keeps a same-named sibling that still exists', () => {
    write('a/subs/probe.ngc', SUB('probe'));
    write('b/subs/probe.ngc', SUB('probe'));
    const project = newProject();
    project.scanRoots([root]);
    expect(project.workspaceNgcUris().length).toBe(2);
    fs.rmSync(abs('a/subs/probe.ngc'), { force: true });
    project.removeNgc(uriOf('a/subs/probe.ngc'));
    const left = project.workspaceNgcUris();
    expect(left.length).toBe(1);
    expect(left[0]).toBe(uriOf('b/subs/probe.ngc'));
  });
});

describe('S16: centralized Project.resolveSubroutine / referencesUniverse', () => {
  it('scopes resolution to the owning config and never bleeds across machines', () => {
    write('a/subs/probe.ngc', SUB('probe'));
    write('b/subs/probe.ngc', SUB('probe'));
    write('a/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('b/b.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.scanRoots([root]);
    expect(project.resolveSubroutine(uriOf('a/main.ngc'), 'probe')).toBe(uriOf('a/subs/probe.ngc'));
    expect(project.resolveSubroutine(uriOf('b/main.ngc'), 'probe')).toBe(uriOf('b/subs/probe.ngc'));
    const uni = project.referencesUniverse(uriOf('a/main.ngc'));
    expect(uni.length).toBe(1);
    expect(uni[0]).toBe(uriOf('a/subs/probe.ngc'));
  });

  it('falls back to the global resolver for a file owned by no config', () => {
    write('loose/probe.ngc', SUB('probe'));
    write('loose/main.ngc', 'o<probe> call\n');
    const project = newProject();
    project.scanRoots([root]);
    expect(project.resolveSubroutine(uriOf('loose/main.ngc'), 'probe')).toBe(uriOf('loose/probe.ngc'));
  });
});

describe('S17: scan depth default is unified', () => {
  it('a default-constructed Project scans to DEFAULT_SCAN_DEPTH (8), not the old 5', () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(8);
    write('a/b/c/d/e/f/deep.ngc', SUB('deep')); // file at dir-depth 6 (> old 5)
    const project = newProject();
    project.scanRoots([root]);
    expect(project.workspaceNgcUris().map(baseOf)).toContain('deep.ngc');
  });
});

describe('GCODE_EXTENSIONS is the single source of truth', () => {
  it('matches the gcode language extensions in the client manifest', () => {
    const manifest = path.join(process.cwd(), 'packages', 'client', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      contributes: { languages: { id: string; extensions?: string[] }[] };
    };
    const gcode = pkg.contributes.languages.find((l) => l.id === 'gcode');
    expect(gcode?.extensions).toBeDefined();
    expect([...GCODE_EXTENSIONS].sort()).toEqual([...gcode!.extensions!].sort());
  });

  it('isGcodePath recognizes each extension and rejects others', () => {
    for (const ext of GCODE_EXTENSIONS) expect(isGcodePath('foo' + ext)).toBe(true);
    expect(isGcodePath('foo.hal')).toBe(false);
    expect(isGcodePath('foo.ini')).toBe(false);
  });
});
