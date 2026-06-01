import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  InitializeResult, SemanticTokensBuilder, DidChangeConfigurationNotification, Diagnostic,
  CompletionItem, FileChangeType, FileEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, SeverityName,
  LineIndex, parseGcode,
  gcodeOwordAt, gcodeDefinition, gcodeReferences, gcodeDocumentHighlights,
  diagnoseGcodeUnresolvedCalls,
} from '@linuxcnc/core';
import {
  MetadataIndex, hoverHal, hoverIni, buildMachineModel, crossFileDiagnostics,
  definition, references, documentHighlights, MachineModel, iniRefsTo,
  completeHal, completeIni, prepareRename, rename, codeActions,
  hoverGcode, completeGcode,
} from '@linuxcnc/metadata';
import {
  buildDocModel, buildDocModelFromText, computeDiagnostics, computeSemanticTokens,
  computeDocumentSymbols, computeFoldingRanges, computeFormat, DocModel,
} from './analysis';
import { Location, DocumentHighlight } from 'vscode-languageserver/node';
import { loadMetadata, scanWorkspaceComps } from './metadata';
import { Project, resolveActiveMachine, pickMachine } from './project';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigCapability = false;

interface Settings {
  diagnosticsEnabled: boolean;
  overrides: Record<string, SeverityName>;
  metadataPath?: string;
  libDir?: string;
  /** Pin which machine (.ini) provides context for HAL files shared by >1 INI. */
  activeMachine?: string;
  /** Max directory depth for the workspace scan (`linuxcnc.scan.maxDepth`). */
  scanMaxDepth?: number;
}
const DEFAULT_SCAN_DEPTH = 8;
let settings: Settings = { diagnosticsEnabled: true, overrides: {} };

let metadata: MetadataIndex | undefined;
let workspaceRoots: string[] = [];
let project: Project;

const modelCache = new Map<string, { version: number; model: DocModel }>();

function getText(uri: string): string | undefined {
  return documents.get(uri)?.getText();
}

function getModel(doc: TextDocument): DocModel {
  const cached = modelCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached.model;
  const model = buildDocModel(doc);
  modelCache.set(doc.uri, { version: doc.version, model });
  return model;
}

connection.onInitialize((params): InitializeResult => {
  hasConfigCapability = !!params.capabilities.workspace?.configuration;
  // `workspaceFolders` is always sent by our supported clients (VS Code >= 1.100),
  // so we don't fall back to the deprecated single `rootUri`.
  workspaceRoots = (params.workspaceFolders ?? [])
    .map((f) => uriToPath(f.uri))
    .filter((p): p is string => !!p);
  project = new Project(getText, () => settings.libDir, () => settings.scanMaxDepth ?? DEFAULT_SCAN_DEPTH);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      completionProvider: {
        triggerCharacters: ['[', ']', '.', '=', '$', ' ', '"'],
        resolveProvider: false,
      },
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      documentFormattingProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: [...SEMANTIC_TOKEN_TYPES], tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS] },
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
  try {
    project.scanRoots(workspaceRoots);
  } catch {
    /* ignore scan errors */
  }
});

function loadMetadataAndOverlay(): void {
  metadata = loadMetadata(settings.metadataPath);
  if (metadata && workspaceRoots.length) {
    try {
      const custom = scanWorkspaceComps(workspaceRoots);
      if (custom.length) metadata.setOverlay(custom);
    } catch {
      /* ignore */
    }
  }
}

async function refreshSettings(): Promise<void> {
  if (hasConfigCapability) {
    const prevDepth = settings.scanMaxDepth ?? DEFAULT_SCAN_DEPTH;
    try {
      const cfg = await connection.workspace.getConfiguration('linuxcnc');
      const depth = Number(cfg?.scan?.maxDepth);
      settings = {
        diagnosticsEnabled: cfg?.diagnostics?.enable !== false,
        overrides: (cfg?.diagnostics?.rules ?? {}) as Record<string, SeverityName>,
        metadataPath: cfg?.metadata?.path || undefined,
        libDir: cfg?.libDir || undefined,
        activeMachine: cfg?.activeMachine || undefined,
        scanMaxDepth: Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : undefined,
      };
    } catch {
      /* keep defaults */
    }
    // A changed scan depth only takes effect on a re-scan of the workspace.
    if ((settings.scanMaxDepth ?? DEFAULT_SCAN_DEPTH) !== prevDepth && workspaceRoots.length) {
      try {
        project.scanRoots(workspaceRoots);
      } catch {
        /* ignore scan errors */
      }
    }
  }
  for (const doc of documents.all()) onDocChanged(doc.uri);
}

connection.onDidChangeConfiguration(() => void refreshSettings());

// --- Validation: merge intra-file + cross-file diagnostics ---------------

function intraDiagnostics(uri: string): Diagnostic[] {
  const open = documents.get(uri);
  const model = open ? getModel(open) : tryBuildFromFs(uri);
  if (!model) return [];
  return computeDiagnostics(model, { overrides: settings.overrides, diagnosticsEnabled: settings.diagnosticsEnabled });
}

function tryBuildFromFs(uri: string): DocModel | undefined {
  try {
    const fs = require('fs') as typeof import('fs');
    const text = fs.readFileSync(URI.parse(uri).fsPath, 'utf8');
    return buildDocModelFromText(uri, text);
  } catch {
    return undefined;
  }
}

/** The machine (.ini) that provides context for `halUri`: the pinned active
 *  machine when it owns the file, otherwise the first owner. */
function machineForHal(uri: string): string | undefined {
  const machines = project.machinesForHal(uri);
  if (!machines.length) return undefined;
  const active = resolveActiveMachine(settings.activeMachine, project.allIniUris());
  return pickMachine(machines, active);
}

/** Build the machine model providing context for `halUri` (honoring the pinned
 *  active machine), or a standalone single-file model for an orphan HAL file. */
function modelForHal(uri: string): MachineModel | undefined {
  if (!metadata) return undefined;
  const ini = machineForHal(uri);
  if (ini) return project.buildModel(ini, metadata);
  const doc = documents.get(uri);
  const model = doc ? getModel(doc) : tryBuildFromFs(uri);
  if (!model?.hal) return undefined;
  return buildMachineModel({
    files: [{ uri, text: model.text, lineIndex: model.lineIndex, hal: model.hal, phase: 'pre', order: 0 }],
    index: metadata,
  });
}

function publish(uri: string, diagnostics: Diagnostic[]): void {
  connection.sendDiagnostics({ uri, diagnostics });
}

function crossForMachine(iniUri: string): Map<string, Diagnostic[]> {
  if (!metadata) return new Map();
  const model = project.buildModel(iniUri, metadata);
  if (!model) return new Map();
  return crossFileDiagnostics(model, metadata, { overrides: settings.overrides });
}

/** Recompute and publish diagnostics for a single URI (intra + any cross). */
function publishUri(uri: string, crossByUri?: Map<string, Diagnostic[]>): void {
  if (settings.diagnosticsEnabled === false) {
    publish(uri, []);
    return;
  }
  const intra = intraDiagnostics(uri);
  let cross: Diagnostic[] = [];
  if (crossByUri) {
    cross = crossByUri.get(uri) ?? [];
  } else if (uri.toLowerCase().endsWith('.hal') && metadata) {
    const ini = machineForHal(uri);
    if (ini) cross = crossForMachine(ini).get(uri) ?? [];
  }
  publish(uri, [...intra, ...cross]);
}

function isGcodeUri(lower: string): boolean {
  return lower.endsWith('.ngc') || lower.endsWith('.nc') || lower.endsWith('.gcode') || lower.endsWith('.tap');
}

/** The subroutine-resolution scope for a G-code file: the config that owns it
 *  (honoring the active-machine pin when several configs enclose the file), its
 *  ordered search dirs, and the roots bounding find-references. */
function gcodeScope(uri: string): ReturnType<Project['subroutineScope']> {
  const active = resolveActiveMachine(settings.activeMachine, project.allIniUris());
  return project.subroutineScope(uri, active);
}

/** Resolve a named subroutine for a G-code file: scoped to its owning config's
 *  search path when one is known (so a call cannot bleed into another machine's
 *  identically-named subroutine), else the global workspace resolver for loose
 *  files that belong to no indexed config. */
function resolveSubFor(uri: string, name: string, scope = gcodeScope(uri)): string | undefined {
  return scope.ownerIni
    ? project.resolveSubroutineScoped(uri, name, scope.searchDirs)
    : project.resolveSubroutineFile(uri, name);
}

/** Cross-file G-code diagnostics: `call`s to subroutines that resolve neither
 *  in-file nor via the owning config's search path. */
function gcodeCrossDiagnostics(uri: string, model: DocModel): Diagnostic[] {
  if (!model.gcode) return [];
  const program = model.gcode;
  const definedKeys = new Set(program.subs.map((s) => s.key));
  const scope = gcodeScope(uri);
  const isResolved = (call: import('@linuxcnc/core').OStatement): boolean => {
    if (call.oword.key !== undefined && definedKeys.has(call.oword.key)) return true;
    if (call.oword.form === 'named' && call.oword.name) {
      return resolveSubFor(uri, call.oword.name, scope) !== undefined;
    }
    return false; // numbered call not defined in-file (numbered subs are file-local)
  };
  return diagnoseGcodeUnresolvedCalls(model.text, program, model.lineIndex, isResolved, {
    overrides: settings.overrides,
  });
}

/** In-file then cross-file go-to-definition for a G-code subroutine label. */
function gcodeDefinitionAt(uri: string, model: DocModel, offset: number): Location[] | null {
  if (!model.gcode) return null;
  const inFile = gcodeDefinition(model.gcode, model.lineIndex, uri, offset);
  if (inFile.length) return inFile;
  const hit = gcodeOwordAt(model.gcode, offset);
  if (hit?.form === 'named' && hit.name) {
    const subUri = resolveSubFor(uri, hit.name);
    if (subUri) {
      const text = project.readFileText(subUri);
      if (text !== undefined) {
        const prog = parseGcode(text);
        const li = new LineIndex(text);
        const def = prog.subs.find((s) => s.key === hit.key);
        const range = def ? li.rangeAt(def.open.oword.start, def.open.oword.end) : li.rangeAt(0, 0);
        return [{ uri: subUri, range }];
      }
      return [{ uri: subUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    }
  }
  return null;
}

/** In-file + workspace find-references for a G-code subroutine label. */
function gcodeReferencesAt(uri: string, model: DocModel, offset: number, includeDecl: boolean): Location[] {
  if (!model.gcode) return [];
  const hit = gcodeOwordAt(model.gcode, offset);
  if (!hit?.key) return [];
  const out = gcodeReferences(model.gcode, model.lineIndex, uri, offset, includeDecl);
  const scope = gcodeScope(uri);
  const universe = scope.ownerIni ? project.ngcUrisUnderRoots(scope.universeRoots) : project.workspaceNgcUris();
  // The universe holds canonical URIs; the open-doc URI may not be, so compare
  // canonically to avoid listing the caller file twice.
  const selfCanon = project.canonicalUri(uri);
  for (const otherUri of universe) {
    if (otherUri === uri || otherUri === selfCanon) continue;
    const text = project.readFileText(otherUri);
    if (text === undefined) continue;
    const prog = parseGcode(text);
    const li = new LineIndex(text);
    for (const st of prog.statements) {
      if (st.oword.key !== hit.key) continue;
      if (st.keyword !== 'call' && st.keyword !== 'sub' && st.keyword !== 'endsub') continue;
      if (!includeDecl && st.keyword === 'sub') continue;
      out.push({ uri: otherUri, range: li.rangeAt(st.oword.start, st.oword.end) });
    }
  }
  return out;
}

/** Top-level: a document changed; revalidate it and any machine siblings. */
function onDocChanged(uri: string): void {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.ini')) {
    project.indexIni(uri);
    publishUri(uri); // INI intra diagnostics
    const cross = crossForMachine(uri);
    const halUris = new Set<string>([...cross.keys()]);
    for (const h of halUris) publishUri(h, cross);
    return;
  }
  if (lower.endsWith('.hal')) {
    const ini = machineForHal(uri);
    if (ini && metadata) {
      // Publish diagnostics for the (preferred) machine's files using that one
      // machine's context — for a shared HAL this avoids "error in A, fine in B"
      // flapping and honors the pinned active machine.
      const cross = crossForMachine(ini);
      for (const h of cross.keys()) publishUri(h, cross);
      if (!cross.has(uri)) publishUri(uri);
    } else {
      publishUri(uri);
    }
    return;
  }
  if (isGcodeUri(lower)) {
    project.indexNgc(uri); // keep the cross-file basename index current
    if (settings.diagnosticsEnabled === false) { publish(uri, []); return; }
    const open = documents.get(uri);
    const model = open ? getModel(open) : tryBuildFromFs(uri);
    if (!model?.gcode) { publishUri(uri); return; }
    publish(uri, [...intraDiagnostics(uri), ...gcodeCrossDiagnostics(uri, model)]);
    return;
  }
  publishUri(uri); // other kinds -> intra only
}

documents.onDidChangeContent((e) => onDocChanged(e.document.uri));
documents.onDidOpen((e) => onDocChanged(e.document.uri));
documents.onDidClose((e) => {
  modelCache.delete(e.document.uri);
  publish(e.document.uri, []);
});

// --- Incremental reindexing on filesystem changes ------------------------
// The client registers a watcher (synchronize.fileEvents) for *.{ini,hal,ngc,...}
// so creating/deleting a machine config mid-session updates the index without a
// reload. Changes are debounced so a burst (e.g. a `git pull` adding many files)
// reindexes once. Files OPEN in the editor are kept current by onDocChanged; the
// watcher only needs to handle on-disk create/change/delete.
const pendingWatched: FileEvent[] = [];
let watchedTimer: ReturnType<typeof setTimeout> | undefined;

function flushWatched(): void {
  watchedTimer = undefined;
  const changes = pendingWatched.splice(0);
  let touched = false;
  for (const c of changes) {
    const lower = c.uri.toLowerCase();
    if (lower.endsWith('.ini')) {
      if (c.type === FileChangeType.Deleted) project.removeIni(c.uri);
      else project.indexIni(c.uri);
      touched = true;
    } else if (isGcodeUri(lower)) {
      if (c.type === FileChangeType.Deleted) project.removeNgc(c.uri);
      else project.indexNgc(c.uri);
      touched = true;
    } else if (lower.endsWith('.hal')) {
      // HAL membership is derived from INI [HAL] entries (read on demand), so the
      // index itself does not change; just refresh consumers below.
      touched = true;
    }
  }
  if (touched) for (const doc of documents.all()) onDocChanged(doc.uri);
}

connection.onDidChangeWatchedFiles((params) => {
  if (!params.changes.length) return;
  pendingWatched.push(...params.changes);
  if (watchedTimer) clearTimeout(watchedTimer);
  watchedTimer = setTimeout(flushWatched, 150);
});

// --- Language feature handlers -------------------------------------------

connection.onHover((params) => {
  if (!metadata) return null;
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = getModel(doc);
  const offset = doc.offsetAt(params.position);
  if (model.kind === 'hal' && model.hal) return hoverHal(model.hal, model.lineIndex, offset, metadata, modelForHal(doc.uri));
  if (model.kind === 'ini' && model.ini) {
    const mm = project.buildModel(doc.uri, metadata);
    const refCount = mm ? (s: string, k: string) => iniRefsTo(mm, s, k).length : undefined;
    return hoverIni(model.ini, model.lineIndex, offset, metadata, refCount);
  }
  if (model.kind === 'gcode') return hoverGcode(model.text, model.lineIndex, offset, metadata);
  return null;
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const dm = getModel(doc);
  if (dm.kind === 'gcode') return gcodeDefinitionAt(doc.uri, dm, offset);
  const model = modelForUri(doc.uri);
  if (!model) return null;
  return definition(model, doc.uri, offset);
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const dm = getModel(doc);
  if (dm.kind === 'gcode') return gcodeReferencesAt(doc.uri, dm, offset, params.context?.includeDeclaration ?? true);
  const model = modelForUri(doc.uri);
  if (!model) return null;
  return references(model, doc.uri, offset, params.context?.includeDeclaration ?? true);
});

connection.onDocumentHighlight((params): DocumentHighlight[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const dm = getModel(doc);
  if (dm.kind === 'gcode' && dm.gcode) return gcodeDocumentHighlights(dm.gcode, dm.lineIndex, offset);
  const model = modelForUri(doc.uri);
  if (!model) return null;
  return documentHighlights(model, doc.uri, offset);
});

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = getModel(doc);
  if (model.kind !== 'gcode') return null;
  return computeFormat(model, {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
    // VS Code populates this from the standard `files.trimTrailingWhitespace`
    // setting (document-scoped, so a `[gcode]` override applies); it is omitted
    // when off, so absent === do not trim.
    trimTrailingWhitespace: params.options.trimTrailingWhitespace ?? false,
  });
});

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? computeDocumentSymbols(getModel(doc)) : [];
});

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? computeFoldingRanges(getModel(doc)) : [];
});

connection.onCompletion((params): CompletionItem[] => {
  if (!metadata) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const model = getModel(doc);
  const offset = doc.offsetAt(params.position);
  if (model.kind === 'hal' && model.hal) {
    return completeHal({
      hal: model.hal, lineIndex: model.lineIndex, text: model.text, offset,
      index: metadata, model: modelForHal(doc.uri),
    });
  }
  if (model.kind === 'ini' && model.ini) {
    return completeIni({ ini: model.ini, lineIndex: model.lineIndex, text: model.text, offset, index: metadata });
  }
  if (model.kind === 'gcode') return completeGcode(model.text, model.lineIndex, offset, metadata);
  return [];
});

/** Build the machine model relevant to a document (HAL owner or the INI itself). */
function modelForUri(uri: string): MachineModel | undefined {
  if (!metadata) return undefined;
  if (uri.toLowerCase().endsWith('.ini')) return project.buildModel(uri, metadata);
  return modelForHal(uri);
}

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = modelForUri(doc.uri);
  if (!model) return null;
  return prepareRename(model, doc.uri, doc.offsetAt(params.position));
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = modelForUri(doc.uri);
  if (!model) return null;
  return rename(model, doc.uri, doc.offsetAt(params.position), params.newName);
});

connection.onCodeAction((params) => {
  if (!metadata) return [];
  const uri = params.textDocument.uri;
  if (!uri.toLowerCase().endsWith('.hal')) return [];
  const diags = params.context.diagnostics;
  if (!diags.length) return [];
  const model = modelForHal(uri);
  if (!model) return [];
  return codeActions(model, uri, diags, metadata);
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

function uriToPath(uri: string): string | undefined {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return undefined;
  }
}

documents.listen(connection);
connection.listen();
