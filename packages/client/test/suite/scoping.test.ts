// End-to-end multi-machine "monorepo" scoping tests. These run in a real VS Code
// extension host against the committed fixture workspace, which contains two
// machine configs (configs/machineA and configs/machineB) that BOTH define a
// subroutine `o<probe>` in a `subs/` dir with different bodies. We assert that
// go-to-definition and find-references on `o<probe>` stay inside the calling
// machine's config and never bleed into the other machine — the Phase-1 fix.
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'PeterStolz.linuxcnc-lsp';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function wsFile(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root, 'no workspace folder open in the e2e host');
  return vscode.Uri.joinPath(root!.uri, ...rel.split('/'));
}

/** Position of the `probe` name inside the first `o<probe>` of a document. */
async function probePosition(uri: vscode.Uri): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const idx = doc.getText().indexOf('o<probe>');
  assert.ok(idx >= 0, `o<probe> not found in ${uri.fsPath}`);
  return { doc, pos: doc.positionAt(idx + 3) }; // inside "probe"
}

interface Loc { uri: vscode.Uri; }
function normalize(items: unknown): Loc[] {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const link = it as vscode.LocationLink;
    if (link.targetUri) return { uri: link.targetUri };
    return { uri: (it as vscode.Location).uri };
  });
}

/** Poll a provider until it yields a non-empty result (indexing can lag right
 *  after the server starts), then return the normalized locations. */
async function pollLocations(
  command: 'vscode.executeDefinitionProvider' | 'vscode.executeReferenceProvider',
  uri: vscode.Uri,
  pos: vscode.Position,
): Promise<Loc[]> {
  for (let i = 0; i < 100; i++) {
    const raw = await vscode.commands.executeCommand(command, uri, pos);
    const locs = normalize(raw);
    if (locs.length) return locs;
    await delay(100);
  }
  return [];
}

const endsWithPath = (u: vscode.Uri, suffix: string): boolean => u.fsPath.replace(/\\/g, '/').endsWith(suffix);

describe('LinuxCNC multi-machine G-code scoping (e2e)', function () {
  this.timeout(120000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in the host`);
    const api = await ext!.activate();
    if (api && api.ready) await api.ready;
  });

  it('go-to-definition on o<probe> resolves to the CALLING machine (A)', async () => {
    const { doc, pos } = await probePosition(wsFile('configs/machineA/main.ngc'));
    const defs = await pollLocations('vscode.executeDefinitionProvider', doc.uri, pos);
    assert.ok(defs.length > 0, 'expected a definition for o<probe>');
    assert.ok(
      defs.every((d) => endsWithPath(d.uri, 'configs/machineA/subs/probe.ngc')),
      `definition should land in machineA, got: ${defs.map((d) => d.uri.fsPath).join(', ')}`,
    );
  });

  it('go-to-definition on o<probe> resolves to the CALLING machine (B), not A', async () => {
    const { doc, pos } = await probePosition(wsFile('configs/machineB/main.ngc'));
    const defs = await pollLocations('vscode.executeDefinitionProvider', doc.uri, pos);
    assert.ok(defs.length > 0, 'expected a definition for o<probe>');
    assert.ok(
      defs.every((d) => endsWithPath(d.uri, 'configs/machineB/subs/probe.ngc')),
      `definition should land in machineB, got: ${defs.map((d) => d.uri.fsPath).join(', ')}`,
    );
  });

  it('find-references on o<probe> stays within machine A', async () => {
    const { doc, pos } = await probePosition(wsFile('configs/machineA/main.ngc'));
    const refs = await pollLocations('vscode.executeReferenceProvider', doc.uri, pos);
    assert.ok(refs.length > 0, 'expected references for o<probe>');
    const paths = refs.map((r) => r.uri.fsPath.replace(/\\/g, '/'));
    assert.ok(paths.some((p) => p.endsWith('configs/machineA/main.ngc')), 'should include the call site');
    assert.ok(paths.some((p) => p.endsWith('configs/machineA/subs/probe.ngc')), 'should include the A definition');
    assert.ok(
      paths.every((p) => p.includes('/configs/machineA/')),
      `references must not bleed into another machine, got: ${paths.join(', ')}`,
    );
  });
});
