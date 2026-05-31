// VSCode extension entry point. Spawns the bundled language server.
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
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
