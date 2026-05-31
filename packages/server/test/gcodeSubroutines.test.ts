import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Project } from '../src/project';

let root: string;
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcnc-ngc-')); });
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

function write(rel: string, content: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return URI.file(p).toString();
}
const uriOf = (rel: string): string => URI.file(path.join(root, rel)).toString();

describe('Project.resolveSubroutineFile', () => {
  it('finds a subroutine .ngc in the calling file\'s own directory', () => {
    const caller = write('own/main.ngc', 'o<probe> call\n');
    write('own/probe.ngc', 'o<probe> sub\nG38.2 Z-10 F50\no<probe> endsub\n');
    const project = new Project(() => undefined, () => undefined);
    expect(project.resolveSubroutineFile(caller, 'probe')).toBe(uriOf('own/probe.ngc'));
  });

  it('finds a subroutine via [RS274NGC]SUBROUTINES search path', () => {
    write('cfg/macros/peck.ngc', 'o<peck> sub\no<peck> endsub\n');
    const iniUri = write('cfg/machine.ini', '[RS274NGC]\nSUBROUTINES = macros\n[HAL]\nHALFILE = x.hal\n');
    const project = new Project(() => undefined, () => undefined);
    project.indexIni(iniUri);
    const caller = uriOf('elsewhere/job.ngc');
    expect(project.resolveSubroutineFile(caller, 'peck')).toBe(uriOf('cfg/macros/peck.ngc'));
  });

  it('finds a subroutine via [DISPLAY]PROGRAM_PREFIX', () => {
    write('cfg2/nc_files/face.ngc', 'o<face> sub\no<face> endsub\n');
    const iniUri = write('cfg2/machine.ini', '[DISPLAY]\nPROGRAM_PREFIX = nc_files\n');
    const project = new Project(() => undefined, () => undefined);
    project.indexIni(iniUri);
    expect(project.resolveSubroutineFile(uriOf('cfg2/x.ngc'), 'face')).toBe(uriOf('cfg2/nc_files/face.ngc'));
  });

  it('resolves a colon-separated SUBROUTINES list', () => {
    write('multi/b/two.ngc', 'o<two> sub\no<two> endsub\n');
    const iniUri = write('multi/machine.ini', '[RS274NGC]\nSUBROUTINES = a:b:c\n');
    const project = new Project(() => undefined, () => undefined);
    project.indexIni(iniUri);
    expect(project.resolveSubroutineFile(uriOf('multi/job.ngc'), 'two')).toBe(uriOf('multi/b/two.ngc'));
  });

  it('falls back to a workspace-wide basename index after scanRoots', () => {
    write('deep/nested/dir/widget.ngc', 'o<widget> sub\no<widget> endsub\n');
    const project = new Project(() => undefined, () => undefined);
    project.scanRoots([root]);
    // A caller in an unrelated directory with no INI search path still resolves.
    expect(project.resolveSubroutineFile(uriOf('unrelated/x.ngc'), 'widget')).toBe(uriOf('deep/nested/dir/widget.ngc'));
    expect(project.workspaceNgcUris()).toContain(uriOf('deep/nested/dir/widget.ngc'));
  });

  it('returns undefined when nothing matches', () => {
    const project = new Project(() => undefined, () => undefined);
    expect(project.resolveSubroutineFile(uriOf('x/y.ngc'), 'does-not-exist')).toBeUndefined();
  });

  it('prefers an open (unsaved) document over disk via getText', () => {
    const callerRel = 'open/main.ngc';
    const subRel = 'open/live.ngc';
    const subUri = uriOf(subRel);
    const caller = URI.file(path.join(root, callerRel)).toString();
    fs.mkdirSync(path.join(root, 'open'), { recursive: true });
    // Only an in-memory document exists for live.ngc (never written to disk).
    const project = new Project((u) => (u === subUri ? 'o<live> sub\no<live> endsub\n' : undefined), () => undefined);
    expect(project.resolveSubroutineFile(caller, 'live')).toBe(subUri);
  });
});
