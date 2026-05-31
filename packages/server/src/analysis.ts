import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  LineIndex, SeverityName, Diagnostic,
  parseHal, parseIni, parseGcode,
  diagnoseHalIntraFile, diagnoseIniIntraFile, diagnoseGcodeIntraFile,
  buildHalSemanticTokens, buildIniSemanticTokens, SemanticTokenItem,
  halDocumentSymbols, iniDocumentSymbols, gcodeDocumentSymbols,
  halFoldingRanges, iniFoldingRanges, gcodeFoldingRanges,
  formatGcode, GcodeFormatOptions,
} from '@linuxcnc/core';
import { DocumentSymbol, FoldingRange, TextEdit } from 'vscode-languageserver';

export type DocKind = 'hal' | 'ini' | 'gcode';

export function docKindFromUri(uri: string): DocKind | undefined {
  const u = uri.toLowerCase();
  if (u.endsWith('.hal')) return 'hal';
  if (u.endsWith('.ini')) return 'ini';
  if (u.endsWith('.ngc') || u.endsWith('.nc') || u.endsWith('.gcode')) return 'gcode';
  return undefined;
}

export function docKind(doc: TextDocument): DocKind | undefined {
  switch (doc.languageId) {
    case 'hal':
      return 'hal';
    case 'linuxcnc-ini':
      return 'ini';
    case 'gcode':
      return 'gcode';
    default:
      return docKindFromUri(doc.uri);
  }
}

/** Build a DocModel directly from text + URI (for non-open sibling files). */
export function buildDocModelFromText(uri: string, text: string): DocModel {
  const lineIndex = new LineIndex(text);
  const kind = docKindFromUri(uri);
  const model: DocModel = { kind, text, lineIndex };
  if (kind === 'hal') model.hal = parseHal(text);
  else if (kind === 'ini') model.ini = parseIni(text);
  else if (kind === 'gcode') model.gcode = parseGcode(text);
  return model;
}

export interface AnalysisOptions {
  overrides?: Record<string, SeverityName>;
  diagnosticsEnabled?: boolean;
}

/** A parsed view of a document, cached per (uri, version) by the caller. */
export interface DocModel {
  kind: DocKind | undefined;
  text: string;
  lineIndex: LineIndex;
  hal?: ReturnType<typeof parseHal>;
  ini?: ReturnType<typeof parseIni>;
  gcode?: ReturnType<typeof parseGcode>;
}

export function buildDocModel(doc: TextDocument): DocModel {
  const text = doc.getText();
  const lineIndex = new LineIndex(text);
  const kind = docKind(doc);
  const model: DocModel = { kind, text, lineIndex };
  if (kind === 'hal') model.hal = parseHal(text);
  else if (kind === 'ini') model.ini = parseIni(text);
  else if (kind === 'gcode') model.gcode = parseGcode(text);
  return model;
}

export function computeDiagnostics(model: DocModel, opts: AnalysisOptions): Diagnostic[] {
  if (opts.diagnosticsEnabled === false) return [];
  const o = { overrides: opts.overrides };
  if (model.kind === 'hal' && model.hal) {
    return diagnoseHalIntraFile(model.text, model.hal, model.lineIndex, o);
  }
  if (model.kind === 'ini' && model.ini) {
    return diagnoseIniIntraFile(model.text, model.ini, model.lineIndex, o);
  }
  if (model.kind === 'gcode' && model.gcode) {
    return diagnoseGcodeIntraFile(model.text, model.gcode, model.lineIndex, o);
  }
  return [];
}

export function computeSemanticTokens(model: DocModel): SemanticTokenItem[] {
  if (model.kind === 'hal' && model.hal) return buildHalSemanticTokens(model.hal, model.lineIndex);
  if (model.kind === 'ini' && model.ini) return buildIniSemanticTokens(model.ini, model.lineIndex);
  return [];
}

export function computeDocumentSymbols(model: DocModel): DocumentSymbol[] {
  if (model.kind === 'hal' && model.hal) return halDocumentSymbols(model.hal, model.lineIndex);
  if (model.kind === 'ini' && model.ini) return iniDocumentSymbols(model.ini, model.lineIndex);
  if (model.kind === 'gcode' && model.gcode) return gcodeDocumentSymbols(model.gcode, model.lineIndex);
  return [];
}

export function computeFoldingRanges(model: DocModel): FoldingRange[] {
  if (model.kind === 'hal') return halFoldingRanges(model.lineIndex);
  if (model.kind === 'ini' && model.ini) return iniFoldingRanges(model.ini, model.lineIndex);
  if (model.kind === 'gcode' && model.gcode) return gcodeFoldingRanges(model.gcode, model.lineIndex);
  return [];
}

/** Formatting edits for a document (currently G-code only). */
export function computeFormat(model: DocModel, opts: GcodeFormatOptions): TextEdit[] {
  if (model.kind === 'gcode' && model.gcode) return formatGcode(model.lineIndex, model.gcode, opts);
  return [];
}
