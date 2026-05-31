import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  InitializeResult, SemanticTokensBuilder, DidChangeConfigurationNotification,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, SeverityName } from '@linuxcnc/core';
import {
  buildDocModel, computeDiagnostics, computeSemanticTokens,
  computeDocumentSymbols, computeFoldingRanges, DocModel,
} from './analysis';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigCapability = false;

interface Settings {
  diagnosticsEnabled: boolean;
  overrides: Record<string, SeverityName>;
}
let settings: Settings = { diagnosticsEnabled: true, overrides: {} };

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
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
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
});

async function refreshSettings(): Promise<void> {
  if (!hasConfigCapability) return;
  try {
    const cfg = await connection.workspace.getConfiguration('linuxcnc');
    settings = {
      diagnosticsEnabled: cfg?.diagnostics?.enable !== false,
      overrides: (cfg?.diagnostics?.rules ?? {}) as Record<string, SeverityName>,
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
