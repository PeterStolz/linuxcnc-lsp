// VSCode extension entry point. Spawns the bundled language server.
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionContext, TextDocument } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

// Sections that identify a LinuxCNC machine INI (vs an unrelated .ini file).
const MACHINE_SECTION =
  /^\s*\[(EMC|HAL|HALUI|KINS|TRAJ|EMCMOT|EMCIO|DISPLAY|RS274NGC|TASK|AXIS_[A-W]|JOINT_\d+|SPINDLE_\d+|KINEMATICS)\]/im;

function looksLikeMachineIni(doc: TextDocument): boolean {
  // Cheap check over the first ~200 lines.
  const text = doc.getText();
  return MACHINE_SECTION.test(text.length > 20000 ? text.slice(0, 20000) : text);
}

/** Switch an .ini document to the linuxcnc-ini language when appropriate. */
async function maybeAssignIni(doc: TextDocument): Promise<void> {
  if (doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.ini')) return;
  if (doc.languageId === 'linuxcnc-ini') return;
  const mode = vscode.workspace.getConfiguration('linuxcnc').get<string>('iniDetection', 'auto');
  if (mode === 'off') return;
  if (mode === 'extension' || looksLikeMachineIni(doc)) {
    await vscode.languages.setTextDocumentLanguage(doc, 'linuxcnc-ini');
  }
}

export function activate(context: ExtensionContext): void {
  // Content-based detection for .ini machine configs.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => void maybeAssignIni(d)),
  );
  for (const d of vscode.workspace.textDocuments) void maybeAssignIni(d);
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'hal' },
      { scheme: 'file', language: 'linuxcnc-ini' },
      { scheme: 'file', language: 'gcode' },
    ],
    synchronize: {},
  };

  client = new LanguageClient('linuxcnc', 'LinuxCNC Language Server', serverOptions, clientOptions);
  void client.start();
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
