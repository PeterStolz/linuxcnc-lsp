// End-to-end G-code o-word rename in a real VS Code host against the committed
// two-machine fixture workspace (configs/machineA and machineB both define a
// subroutine o<probe>). Rename must edit the calling machine's call + sub + endsub
// and the scoped cross-file definition, and never bleed into the other machine.
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'PeterStolz.linuxcnc-lsp';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function wsFile(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root, 'no workspace folder open in the e2e host');
  return vscode.Uri.joinPath(root!.uri, ...rel.split('/'));
}

/** Position inside the `probe` name of the first `o<probe>` in a document. */
async function probePos(uri: vscode.Uri): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const idx = doc.getText().indexOf('o<probe>');
  assert.ok(idx >= 0, `o<probe> not found in ${uri.fsPath}`);
  return { doc, pos: doc.positionAt(idx + 3) };
}

/** Poll the rename provider until it returns a non-empty edit (indexing can lag
 *  just after the server starts). */
async function pollRename(
  uri: vscode.Uri, pos: vscode.Position, newName: string,
): Promise<vscode.WorkspaceEdit | undefined> {
  for (let i = 0; i < 100; i++) {
    const we = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider', uri, pos, newName,
    );
    if (we && we.size > 0) return we;
    await delay(100);
  }
  return undefined;
}

const machineOf = (we: vscode.WorkspaceEdit): string[] =>
  we.entries().map(([u]) => u.fsPath.replace(/\\/g, '/'));

describe('LinuxCNC G-code o-word rename (e2e)', function () {
  this.timeout(120000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in the host`);
    const api = await ext!.activate();
    if (api && api.ready) await api.ready;
  });

  it('renames o<probe> across machine A only (call + sub + endsub), never machine B', async () => {
    const { doc, pos } = await probePos(wsFile('configs/machineA/main.ngc'));
    const we = await pollRename(doc.uri, pos, 'touchoff');
    assert.ok(we, 'expected a rename WorkspaceEdit for o<probe>');
    const touched = machineOf(we!);
    assert.ok(touched.some((p) => p.endsWith('configs/machineA/main.ngc')), 'should edit the call site');
    assert.ok(touched.some((p) => p.endsWith('configs/machineA/subs/probe.ngc')), 'should edit the A definition');
    assert.ok(
      touched.every((p) => p.includes('/configs/machineA/')),
      `rename must not bleed into another machine, got: ${touched.join(', ')}`,
    );
    // Only the inner name is replaced — never the o<...> wrapper.
    for (const [, edits] of we!.entries()) {
      for (const e of edits) assert.strictEqual(e.newText, 'touchoff');
    }
  });

  it('renames o<probe> in machine B independently of A', async () => {
    const { doc, pos } = await probePos(wsFile('configs/machineB/main.ngc'));
    const we = await pollRename(doc.uri, pos, 'touchoff');
    assert.ok(we, 'expected a rename WorkspaceEdit for o<probe> in B');
    const touched = machineOf(we!);
    assert.ok(touched.some((p) => p.endsWith('configs/machineB/subs/probe.ngc')), 'should edit the B definition');
    assert.ok(
      touched.every((p) => p.includes('/configs/machineB/')),
      `rename must stay within machine B, got: ${touched.join(', ')}`,
    );
  });
});
