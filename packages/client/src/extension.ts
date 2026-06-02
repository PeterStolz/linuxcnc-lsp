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

/** Returned from `activate` so tests (and other extensions) can await the
 *  language server becoming ready before issuing requests. */
export interface LinuxcncApi {
  client: LanguageClient;
  /** Resolves once the client has started and the server is initialized. */
  ready: Promise<void>;
}

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

/** Quick-pick a machine INI and pin it as `linuxcnc.activeMachine` — used when a
 *  `.hal` file is shared by more than one machine. */
async function selectActiveMachine(): Promise<void> {
  const files = await vscode.workspace.findFiles('**/*.ini', '**/node_modules/**', 2000);
  const machineInis: { uri: vscode.Uri; rel: string }[] = [];
  for (const uri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      if (MACHINE_SECTION.test(text.length > 20000 ? text.slice(0, 20000) : text)) {
        machineInis.push({ uri, rel: vscode.workspace.asRelativePath(uri) });
      }
    } catch {
      /* skip unreadable */
    }
  }
  if (machineInis.length === 0) {
    void vscode.window.showInformationMessage('LinuxCNC: no machine .ini files found in this workspace.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('linuxcnc');
  const current = cfg.get<string>('activeMachine', '');
  const items: vscode.QuickPickItem[] = [
    { label: '$(clear-all) None (use the first machine found)', description: current ? '' : 'current' },
    ...machineInis.map((m) => ({ label: m.rel, description: current && m.rel.endsWith(current) ? 'current' : '' })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Pin the active machine for shared HAL files',
    placeHolder: 'Diagnostics, hover, go-to-definition and completion will use this machine',
  });
  if (!pick) return;
  const value = pick.label.startsWith('$(clear-all)') ? '' : pick.label;
  await cfg.update('activeMachine', value, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(
    value ? `LinuxCNC active machine: ${value}` : 'LinuxCNC active machine cleared.',
  );
}

export function activate(context: ExtensionContext): LinuxcncApi {
  // Content-based detection for .ini machine configs.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => void maybeAssignIni(d)),
    vscode.commands.registerCommand('linuxcnc.selectActiveMachine', () => void selectActiveMachine()),
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

  // Watch config files across the workspace so the server reindexes when a
  // machine config is created/deleted/changed on disk (not just in open editors).
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ini,hal,ngc,nc,gcode,tap}');
  context.subscriptions.push(fileWatcher);

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'hal' },
      { scheme: 'file', language: 'linuxcnc-ini' },
      { scheme: 'file', language: 'gcode' },
    ],
    synchronize: { fileEvents: fileWatcher },
  };

  client = new LanguageClient('linuxcnc', 'LinuxCNC Language Server', serverOptions, clientOptions);
  const ready = client.start();
  return { client, ready };
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
