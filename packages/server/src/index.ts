import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  InitializeResult, SemanticTokensBuilder, DidChangeConfigurationNotification,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, SeverityName } from '@linuxcnc/core';
import { MetadataIndex, hoverHal, hoverIni } from '@linuxcnc/metadata';
import {
  buildDocModel, computeDiagnostics, computeSemanticTokens,
  computeDocumentSymbols, computeFoldingRanges, DocModel,
} from './analysis';
import { loadMetadata, scanWorkspaceComps } from './metadata';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigCapability = false;

interface Settings {
  diagnosticsEnabled: boolean;
  overrides: Record<string, SeverityName>;
  metadataPath?: string;
}
let settings: Settings = { diagnosticsEnabled: true, overrides: {} };

let metadata: MetadataIndex | undefined;
let workspaceRoots: string[] = [];

// Cache parsed models by uri+version to avoid re-parsing for every request.
const modelCache = new Map<string, { version: number; model: DocModel }>();

function getModel(doc: TextDocument): DocModel {
  const cached = modelCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached.model;
  const model = buildDocModel(doc);
  modelCache.set(doc.uri, { version: doc.version, model });
  return model;
}

connection.onInitialize((params): InitializeResult => {
  hasConfigCapability = !!params.capabilities.workspace?.configuration;
  workspaceRoots = (params.workspaceFolders ?? [])
    .map((f) => uriToPath(f.uri))
    .filter((p): p is string => !!p);
  if (params.rootUri) {
    const r = uriToPath(params.rootUri);
    if (r && !workspaceRoots.includes(r)) workspaceRoots.push(r);
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
        },
        full: true,
      },
    },
  };
});

connection.onInitialized(() => {
  if (hasConfigCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
    void refreshSettings();
  }
  loadMetadataAndOverlay();
});

function loadMetadataAndOverlay(): void {
  metadata = loadMetadata(settings.metadataPath);
  if (metadata && workspaceRoots.length) {
    try {
      const custom = scanWorkspaceComps(workspaceRoots);
      if (custom.length) {
        metadata.setOverlay(custom);
        connection.console.info(`linuxcnc: loaded ${custom.length} workspace .comp component(s)`);
      }
    } catch {
      /* ignore overlay scan errors */
    }
  }
  if (!metadata) connection.console.warn('linuxcnc: metadata DB not found; hover/completion disabled');
}

function uriToPath(uri: string): string | undefined {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return undefined;
  }
}

async function refreshSettings(): Promise<void> {
  if (!hasConfigCapability) return;
  try {
    const cfg = await connection.workspace.getConfiguration('linuxcnc');
    settings = {
      diagnosticsEnabled: cfg?.diagnostics?.enable !== false,
      overrides: (cfg?.diagnostics?.rules ?? {}) as Record<string, SeverityName>,
      metadataPath: cfg?.metadata?.path || undefined,
    };
  } catch {
    // keep defaults
  }
  // Re-validate all open documents with the new settings.
  for (const doc of documents.all()) validate(doc);
}

connection.onDidChangeConfiguration(() => {
  void refreshSettings();
});

function validate(doc: TextDocument): void {
  const model = getModel(doc);
  const diagnostics = computeDiagnostics(model, {
    overrides: settings.overrides,
    diagnosticsEnabled: settings.diagnosticsEnabled,
  });
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((e) => validate(e.document));

documents.onDidClose((e) => {
  modelCache.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onHover((params) => {
  if (!metadata) return null;
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = getModel(doc);
  const offset = doc.offsetAt(params.position);
  if (model.kind === 'hal' && model.hal) return hoverHal(model.hal, model.lineIndex, offset, metadata);
  if (model.kind === 'ini' && model.ini) return hoverIni(model.ini, model.lineIndex, offset, metadata);
  return null;
});

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return computeDocumentSymbols(getModel(doc));
});

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return computeFoldingRanges(getModel(doc));
});

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  const builder = new SemanticTokensBuilder();
  if (!doc) return builder.build();
  for (const t of computeSemanticTokens(getModel(doc))) {
    builder.push(t.line, t.char, t.length, t.type, t.modifiers);
  }
  return builder.build();
});

documents.listen(connection);
connection.listen();
