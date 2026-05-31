// @linuxcnc/server — language server entry point. Wiring lands in P1+.
import { CORE_VERSION } from '@linuxcnc/core';

// Placeholder: a real server is created with createConnection() in P1.
export function serverInfo(): string {
  return `linuxcnc language server (core ${CORE_VERSION})`;
}

if (require.main === module) {
  // Started as a child process by the client; real LSP loop added in P1.
  serverInfo();
}
