// Multi-machine "monorepo" behavior: per-config G-code subroutine scoping
// (Phase 1) and incremental reindexing (Phase 2). LinuxCNC resolves o<name>
// calls per running INI (rs274ngc_pre.cc find_ngc_file: PROGRAM_PREFIX then
// SUBROUTINES, no cross-config namespace), so a call must never bleed into
// another machine's identically-named subroutine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Project } from '../src/project';

let root: string;
// realpath so the test's expected URIs match the server's canonical (realpath'd)
// URIs — os.tmpdir() is itself a symlink on macOS (/var -> /private/var).
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcnc-mono-'))); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

function write(rel: string, content: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return URI.file(p).toString();
}
function rm(rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
}
const uriOf = (rel: string): string => URI.file(path.join(root, rel)).toString();
const SUB = (name: string): string => `o<${name}> sub\nG1 X1\no<${name}> endsub\n`;
const newProject = (depth?: number): Project =>
  new Project(() => undefined, () => undefined, depth === undefined ? undefined : () => depth);

describe('subroutine search-path order (matches interpreter find_ngc_file)', () => {
  it('PROGRAM_PREFIX is searched before SUBROUTINES', () => {
    const iniUri = write('m/a.ini', '[DISPLAY]\nPROGRAM_PREFIX = pp\n[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.indexIni(iniUri);
    const dirs = project.subDirsForIni(iniUri);
    expect(dirs).toEqual([path.join(root, 'm', 'pp'), path.join(root, 'm', 'subs')]);
  });

  it('a name in both PROGRAM_PREFIX and SUBROUTINES resolves to PROGRAM_PREFIX', () => {
    write('m/pp/dup.ngc', SUB('dup'));
    write('m/subs/dup.ngc', SUB('dup'));
    const iniUri = write('m/a.ini', '[DISPLAY]\nPROGRAM_PREFIX = pp\n[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.indexIni(iniUri);
    // Caller sits in the config root (no dup.ngc there) so own-dir doesn't win.
    const dirs = project.subDirsForIni(iniUri);
    expect(project.resolveSubroutineScoped(uriOf('m/job.ngc'), 'dup', dirs)).toBe(uriOf('m/pp/dup.ngc'));
  });
});

describe('iniOwnersForNgc — nearest enclosing config', () => {
  it('picks the deepest enclosing INI directory', () => {
    const outer = write('cfg/outer.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const inner = write('cfg/machineX/x.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.indexIni(outer);
    project.indexIni(inner);
    // A .ngc under cfg/machineX is owned by the inner INI, not the outer one.
    expect(project.iniOwnersForNgc(uriOf('cfg/machineX/main.ngc'))).toEqual([inner]);
    // A .ngc directly under cfg is owned by the outer INI.
    expect(project.iniOwnersForNgc(uriOf('cfg/loose.ngc'))).toEqual([outer]);
  });

  it('returns empty for a .ngc enclosed by no indexed INI', () => {
    const iniUri = write('cfg/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.indexIni(iniUri);
    expect(project.iniOwnersForNgc(uriOf('elsewhere/loose.ngc'))).toEqual([]);
  });

  it('does not treat a sibling dir with a shared prefix as enclosing (/a/b vs /a/bc)', () => {
    const iniUri = write('mach/m.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.indexIni(iniUri);
    // "mach-2" shares the textual prefix "mach" but is not nested under it.
    expect(project.iniOwnersForNgc(uriOf('mach-2/main.ngc'))).toEqual([]);
  });
});

describe('cross-config bleed is eliminated (the core Phase-1 fix)', () => {
  // Two machines, each with subs/probe.ngc holding DIFFERENT code. A call from
  // machine A must resolve to A's probe, never B's, regardless of scan order.
  function buildTwoMachines(): Project {
    write('A/subs/probe.ngc', `o<probe> sub\n(A version)\no<probe> endsub\n`);
    write('B/subs/probe.ngc', `o<probe> sub\n(B version)\no<probe> endsub\n`);
    write('A/main.ngc', 'o<probe> call\n');
    write('B/main.ngc', 'o<probe> call\n');
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('B/b.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.scanRoots([root]);
    return project;
  }

  it('scoped resolution lands in the calling machine\'s own subroutine', () => {
    const project = buildTwoMachines();
    const aScope = project.subroutineScope(uriOf('A/main.ngc'));
    const bScope = project.subroutineScope(uriOf('B/main.ngc'));
    expect(project.resolveSubroutineScoped(uriOf('A/main.ngc'), 'probe', aScope.searchDirs))
      .toBe(uriOf('A/subs/probe.ngc'));
    expect(project.resolveSubroutineScoped(uriOf('B/main.ngc'), 'probe', bScope.searchDirs))
      .toBe(uriOf('B/subs/probe.ngc'));
  });

  it('the OLD global resolver would have bled across machines (documents the bug)', () => {
    const project = buildTwoMachines();
    // The global resolver searches own dir, then the UNION of all configs' dirs,
    // then any workspace basename match — so a B-only setup could surface A's file.
    const global = project.resolveSubroutineFile(uriOf('B/main.ngc'), 'probe');
    // It resolves to *some* probe.ngc; the point is it is not machine-scoped.
    expect(global === uriOf('A/subs/probe.ngc') || global === uriOf('B/subs/probe.ngc')).toBe(true);
  });

  it('a missing sub stays unresolved even when another machine defines it', () => {
    write('A/subs/special.ngc', SUB('special')); // only A has it
    write('B/b.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('B/main.ngc', 'o<special> call\n');
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.scanRoots([root]);
    const bScope = project.subroutineScope(uriOf('B/main.ngc'));
    expect(bScope.ownerIni).toBe(uriOf('B/b.ini'));
    // B's scope must NOT see A's special.ngc -> stays undefined -> diagnostic fires.
    expect(project.resolveSubroutineScoped(uriOf('B/main.ngc'), 'special', bScope.searchDirs)).toBeUndefined();
  });
});

describe('shared library reached via a relative path stays resolvable', () => {
  it('resolves a sub in a shared ../shared dir declared by SUBROUTINES', () => {
    write('shared/common.ngc', SUB('common'));
    const iniUri = write('configs/mach/m.ini', '[RS274NGC]\nSUBROUTINES = ../../shared\n');
    write('configs/mach/main.ngc', 'o<common> call\n');
    const project = newProject();
    project.scanRoots([root]);
    const scope = project.subroutineScope(uriOf('configs/mach/main.ngc'));
    expect(scope.ownerIni).toBe(iniUri);
    // The shared dir lives OUTSIDE the config subtree but is a declared dir, so it
    // is still searched (regression guard: don't restrict to the subtree only).
    expect(project.resolveSubroutineScoped(uriOf('configs/mach/main.ngc'), 'common', scope.searchDirs))
      .toBe(uriOf('shared/common.ngc'));
  });
});

describe('active-machine pin disambiguates when configs share a directory', () => {
  it('honors the pinned machine\'s search path', () => {
    write('cfg/asubs/thing.ngc', SUB('thing'));
    write('cfg/bsubs/thing.ngc', SUB('thing'));
    const aUri = write('cfg/a.ini', '[RS274NGC]\nSUBROUTINES = asubs\n');
    const bUri = write('cfg/b.ini', '[RS274NGC]\nSUBROUTINES = bsubs\n');
    write('cfg/job.ngc', 'o<thing> call\n');
    const project = newProject();
    project.indexIni(aUri);
    project.indexIni(bUri);
    const caller = uriOf('cfg/job.ngc');
    // Both INIs share dir cfg/ -> both are owners.
    expect(project.iniOwnersForNgc(caller).sort()).toEqual([aUri, bUri].sort());
    const pinB = project.subroutineScope(caller, bUri);
    expect(pinB.ownerIni).toBe(bUri);
    expect(project.resolveSubroutineScoped(caller, 'thing', pinB.searchDirs)).toBe(uriOf('cfg/bsubs/thing.ngc'));
    const pinA = project.subroutineScope(caller, aUri);
    expect(project.resolveSubroutineScoped(caller, 'thing', pinA.searchDirs)).toBe(uriOf('cfg/asubs/thing.ngc'));
  });
});

describe('find-references universe is scoped to the owning config', () => {
  it('ngcUrisUnderRoots includes the config subtree + declared dirs, excludes other machines', () => {
    write('A/main.ngc', 'o<probe> call\n');
    write('A/subs/probe.ngc', SUB('probe'));
    write('B/main.ngc', 'o<probe> call\n');
    write('B/subs/probe.ngc', SUB('probe'));
    write('shared/lib.ngc', SUB('lib'));
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = ../shared\n');
    write('B/b.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    const project = newProject();
    project.scanRoots([root]);
    const scope = project.subroutineScope(uriOf('A/main.ngc'));
    const universe = project.ngcUrisUnderRoots(scope.universeRoots);
    expect(universe).toContain(uriOf('A/main.ngc'));
    expect(universe).toContain(uriOf('A/subs/probe.ngc'));
    expect(universe).toContain(uriOf('shared/lib.ngc')); // declared dir is in scope
    expect(universe).not.toContain(uriOf('B/main.ngc'));
    expect(universe).not.toContain(uriOf('B/subs/probe.ngc'));
  });
});

describe('loose .ngc with no enclosing config falls back to global', () => {
  it('subroutineScope returns no ownerIni so callers use the global resolver', () => {
    write('deep/nested/widget.ngc', SUB('widget'));
    const project = newProject();
    project.scanRoots([root]);
    const scope = project.subroutineScope(uriOf('unrelated/x.ngc'));
    expect(scope.ownerIni).toBeUndefined();
    expect(scope.searchDirs).toEqual([]);
    // Global fallback still works for the loose file.
    expect(project.resolveSubroutineFile(uriOf('unrelated/x.ngc'), 'widget')).toBe(uriOf('deep/nested/widget.ngc'));
  });
});

describe('Phase 2 — incremental reindexing', () => {
  it('removeIni drops HAL associations and ownership', () => {
    write('m/x.hal', 'loadrt foo\n');
    const iniUri = write('m/m.ini', '[RS274NGC]\nSUBROUTINES = subs\n[HAL]\nHALFILE = x.hal\n');
    const project = newProject();
    project.indexIni(iniUri);
    const halUri = uriOf('m/x.hal');
    expect(project.machinesForHal(halUri)).toContain(iniUri);
    expect(project.iniOwnersForNgc(uriOf('m/main.ngc'))).toEqual([iniUri]);

    project.removeIni(iniUri);
    expect(project.allIniUris()).not.toContain(iniUri);
    expect(project.machinesForHal(halUri)).toEqual([]);
    expect(project.iniOwnersForNgc(uriOf('m/main.ngc'))).toEqual([]);
    expect(project.subDirsForIni(iniUri)).toEqual([]);
  });

  it('removeNgc drops the file from the basename index', () => {
    write('d/widget.ngc', SUB('widget'));
    const project = newProject();
    project.scanRoots([root]);
    const wUri = uriOf('d/widget.ngc');
    expect(project.workspaceNgcUris()).toContain(wUri);
    project.removeNgc(wUri);
    expect(project.workspaceNgcUris()).not.toContain(wUri);
    expect(project.resolveSubroutineFile(uriOf('x/y.ngc'), 'widget')).toBeUndefined();
  });

  it('indexing a newly created INI makes it own its directory', () => {
    const project = newProject();
    project.scanRoots([root]); // empty workspace
    expect(project.iniOwnersForNgc(uriOf('newmach/main.ngc'))).toEqual([]);
    const iniUri = write('newmach/m.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    project.indexIni(iniUri); // simulates the didChangeWatchedFiles "created" path
    expect(project.iniOwnersForNgc(uriOf('newmach/main.ngc'))).toEqual([iniUri]);
  });

  it('incremental deltas converge to the same state as a full re-scan', () => {
    // Initial tree.
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('A/subs/p.ngc', SUB('p'));
    write('B/b.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('B/subs/p.ngc', SUB('p'));
    const incremental = newProject();
    incremental.scanRoots([root]);

    // Mutate on disk: delete machine B, add machine C.
    rm('B/b.ini');
    rm('B/subs/p.ngc');
    write('C/c.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('C/subs/p.ngc', SUB('p'));
    write('C/main.ngc', 'o<p> call\n');

    // Apply the same deltas incrementally (what the watcher handler does).
    incremental.removeIni(uriOf('B/b.ini'));
    incremental.removeNgc(uriOf('B/subs/p.ngc'));
    incremental.indexIni(uriOf('C/c.ini'));
    incremental.indexNgc(uriOf('C/subs/p.ngc'));
    incremental.indexNgc(uriOf('C/main.ngc'));

    // A fresh project scanning the final on-disk state.
    const full = newProject();
    full.scanRoots([root]);

    expect(incremental.allIniUris().sort()).toEqual(full.allIniUris().sort());
    expect(incremental.workspaceNgcUris().sort()).toEqual(full.workspaceNgcUris().sort());
    // Resolution agrees for the new machine's call.
    const cCaller = uriOf('C/main.ngc');
    const incScope = incremental.subroutineScope(cCaller);
    const fullScope = full.subroutineScope(cCaller);
    expect(incScope.ownerIni).toBe(fullScope.ownerIni);
    expect(incremental.resolveSubroutineScoped(cCaller, 'p', incScope.searchDirs))
      .toBe(full.resolveSubroutineScoped(cCaller, 'p', fullScope.searchDirs));
  });
});

describe('Phase 2 — configurable scan depth', () => {
  it('a shallow maxDepth misses a deeply-nested file that a deeper one finds', () => {
    write('a/b/c/d/e/deep.ngc', SUB('deep'));
    const shallow = newProject(2);
    shallow.scanRoots([root]);
    expect(shallow.workspaceNgcUris()).not.toContain(uriOf('a/b/c/d/e/deep.ngc'));
    const deep = newProject(10);
    deep.scanRoots([root]);
    expect(deep.workspaceNgcUris()).toContain(uriOf('a/b/c/d/e/deep.ngc'));
  });
});

describe('fuzz-hardening: path traversal, symlinks, case canonicalization', () => {
  it('rejects a subroutine name containing a path separator (no traversal/bleed)', () => {
    // A call like o<../../B/secret> must not escape the config's search dirs.
    write('B/secret.ngc', SUB('secret'));
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('A/main.ngc', 'o<../../B/secret> call\n');
    const project = newProject();
    project.scanRoots([root]);
    const scope = project.subroutineScope(uriOf('A/main.ngc'));
    expect(scope.ownerIni).toBe(uriOf('A/a.ini'));
    // Even though B/secret.ngc exists, the traversal name does not resolve.
    expect(project.resolveSubroutineScoped(uriOf('A/main.ngc'), '../../B/secret', scope.searchDirs)).toBeUndefined();
    expect(project.resolveSubroutineFile(uriOf('A/main.ngc'), '../../B/secret')).toBeUndefined();
  });

  it('indexes + resolves a subroutine under a SYMLINKED search dir, and references see it', () => {
    write('real/probe.ngc', SUB('probe'));
    write('A/main.ngc', 'o<probe> call\n');
    write('A/a.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'A', 'subs'), 'dir');
    const project = newProject();
    project.scanRoots([root]);
    const def = uriOf('real/probe.ngc'); // canonical (symlink dereferenced)
    // The indexer followed the symlinked dir and stored the file under its real path.
    expect(project.workspaceNgcUris()).toContain(def);
    const scope = project.subroutineScope(uriOf('A/main.ngc'));
    expect(scope.ownerIni).toBe(uriOf('A/a.ini'));
    // Resolution returns the canonical (real) URI, matching the index...
    expect(project.resolveSubroutineScoped(uriOf('A/main.ngc'), 'probe', scope.searchDirs)).toBe(def);
    // ...and the find-references universe contains it (canonical roots).
    expect(project.ngcUrisUnderRoots(scope.universeRoots)).toContain(def);
  });

  it('returns the canonical (true-cased) URI for a case-mismatched call', () => {
    write('cfg/subs/probe.ngc', SUB('probe')); // on-disk name is lowercase
    write('cfg/c.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    write('cfg/main.ngc', 'o<Probe> call\n');
    const project = newProject();
    project.scanRoots([root]);
    const def = uriOf('cfg/subs/probe.ngc');
    const scope = project.subroutineScope(uriOf('cfg/main.ngc'));
    // o<Probe> resolves to the real lowercase file (via the lowercase candidate, or
    // case-folding on a case-insensitive FS), and the URI is canonical either way —
    // never a phantom "Probe.ngc". So it matches the index and find-references.
    expect(project.resolveSubroutineScoped(uriOf('cfg/main.ngc'), 'Probe', scope.searchDirs)).toBe(def);
    expect(project.workspaceNgcUris()).toContain(def);
    expect(project.ngcUrisUnderRoots(scope.universeRoots)).toContain(def);
  });

  it('a symlinked sub FILE stays at its in-scope location (resolution == references universe)', () => {
    // sub.ngc lives in the declared dir as a symlink whose target is OUTSIDE the
    // config. It must NOT be dereferenced out of scope: go-to-definition and
    // find-references must agree on the in-scope path.
    write('elsewhere/target.ngc', SUB('sub'));
    write('cfg/main.ngc', 'o<sub> call\n');
    write('cfg/c.ini', '[RS274NGC]\nSUBROUTINES = subs\n');
    fs.mkdirSync(path.join(root, 'cfg', 'subs'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere', 'target.ngc'), path.join(root, 'cfg', 'subs', 'sub.ngc'));
    const project = newProject();
    project.scanRoots([root]);
    const scope = project.subroutineScope(uriOf('cfg/main.ngc'));
    expect(scope.ownerIni).toBe(uriOf('cfg/c.ini'));
    const resolved = project.resolveSubroutineScoped(uriOf('cfg/main.ngc'), 'sub', scope.searchDirs);
    // In-scope symlink location, NOT the dereferenced target dir.
    expect(resolved).toBe(uriOf('cfg/subs/sub.ngc'));
    expect(project.workspaceNgcUris()).toContain(uriOf('cfg/subs/sub.ngc'));
    expect(project.ngcUrisUnderRoots(scope.universeRoots)).toContain(resolved!);
  });
});
