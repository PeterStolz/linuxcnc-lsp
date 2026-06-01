// End-to-end formatter tests. These run in a real VS Code extension host: a real
// .ngc file is opened, the request goes through our vscode-languageclient (which
// augments FormattingOptions from `files.trimTrailingWhitespace`, exactly like a
// user's Format Document), into the spawned language server, and back. We then
// apply the returned edits and assert the document text. Different settings are
// exercised by toggling files.trimTrailingWhitespace and the indent options.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'PeterStolz.linuxcnc-lsp';
const SP2: vscode.FormattingOptions = { tabSize: 2, insertSpaces: true };
const TAB4: vscode.FormattingOptions = { tabSize: 4, insertSpaces: false };

let counter = 0;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function setTrim(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update('files.trimTrailingWhitespace', value, vscode.ConfigurationTarget.Global);
}

/** Invoke the document formatting provider. Note: executeFormatDocumentProvider
 *  returns `undefined` (not `[]`) when the result has no edits, so we cannot use
 *  the return value to detect provider readiness — we treat undefined as an empty
 *  edit list and prove the provider is live once in before() via warmUp(). */
async function formatEdits(uri: vscode.Uri, opts: vscode.FormattingOptions): Promise<vscode.TextEdit[]> {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
    'vscode.executeFormatDocumentProvider', uri, opts,
  );
  return Array.isArray(edits) ? edits : [];
}

/** Block until the formatting provider is registered, proven by formatting an
 *  un-indented sub body that MUST yield at least one edit. */
async function warmUp(): Promise<void> {
  const file = path.join(os.tmpdir(), `lcnc-e2e-warmup-${process.pid}.ngc`);
  fs.writeFileSync(file, 'o<w> sub\nG1 X1\no<w> endsub\n');
  const uri = vscode.Uri.file(file);
  await vscode.workspace.openTextDocument(uri);
  for (let i = 0; i < 100; i++) {
    if ((await formatEdits(uri, SP2)).length > 0) return;
    await delay(100);
  }
  throw new Error('formatting provider never became ready');
}

interface FormatResult { text: string; languageId: string; editCount: number; uri: vscode.Uri }

async function format(content: string, opts: vscode.FormattingOptions): Promise<FormatResult> {
  const file = path.join(os.tmpdir(), `lcnc-e2e-${process.pid}-${counter++}.ngc`);
  fs.writeFileSync(file, content);
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const edits = await formatEdits(uri, opts);
  const we = new vscode.WorkspaceEdit();
  we.set(uri, edits);
  await vscode.workspace.applyEdit(we);
  return { text: doc.getText(), languageId: doc.languageId, editCount: edits.length, uri };
}

describe('LinuxCNC G-code formatter (e2e)', function () {
  this.timeout(120000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in the host`);
    const api = await ext!.activate();
    if (api && api.ready) await api.ready;
    await setTrim(false);
    await warmUp();
  });

  afterEach(async () => {
    // Don't leak the trim setting between cases.
    await setTrim(false);
  });

  it('recognizes a .ngc file as the gcode language', async () => {
    const r = await format('G0 X0\n', SP2);
    assert.strictEqual(r.languageId, 'gcode');
  });

  it('default: preserves blank-but-spaced lines and trailing whitespace (issue #11)', async () => {
    await setTrim(false);
    const r = await format('o<p> sub\nG1 X1  \n   \no<p> endsub\n', SP2);
    assert.strictEqual(r.text, 'o<p> sub\n  G1 X1  \n   \no<p> endsub\n');
  });

  it('default: a correctly-indented flat program is a no-op (zero edits)', async () => {
    await setTrim(false);
    const src = 'G21\nG90\nG0 X0 Y0\nM2\n';
    const r = await format(src, SP2);
    assert.strictEqual(r.editCount, 0);
    assert.strictEqual(r.text, src);
  });

  it('files.trimTrailingWhitespace=true: trims trailing + empties blank-spaced lines', async () => {
    await setTrim(true);
    const r = await format('o<p> sub\nG1 X1  \n   \no<p> endsub\n', SP2);
    assert.strictEqual(r.text, 'o<p> sub\n  G1 X1\n\no<p> endsub\n');
  });

  it('honors tabs + tabSize from the formatting options', async () => {
    await setTrim(false);
    const r = await format('o<p> sub\nG1 X1  \no<p> endsub\n', TAB4);
    assert.strictEqual(r.text, 'o<p> sub\n\tG1 X1  \no<p> endsub\n');
  });

  it('preserves CRLF line endings (default)', async () => {
    await setTrim(false);
    const r = await format('o<p> sub\r\nG1 X1  \r\n   \r\no<p> endsub\r\n', SP2);
    assert.strictEqual(r.text, 'o<p> sub\r\n  G1 X1  \r\n   \r\no<p> endsub\r\n');
  });

  it('is idempotent: a second format produces no edits (trim on)', async () => {
    await setTrim(true);
    const r = await format('o<p> sub\nG1 X1  \n   \no<p> endsub\n', SP2);
    const again = await formatEdits(r.uri, SP2);
    assert.strictEqual(again.length, 0, 'second format should be a no-op');
  });

  it('the same file formats differently as the setting flips', async () => {
    const src = 'G0 X1  \n   \nM2\n';
    await setTrim(false);
    const off = await format(src, SP2);
    assert.strictEqual(off.text, src, 'trim off must preserve');
    await setTrim(true);
    const on = await format(src, SP2);
    assert.strictEqual(on.text, 'G0 X1\n\nM2\n', 'trim on must clean');
  });
});
