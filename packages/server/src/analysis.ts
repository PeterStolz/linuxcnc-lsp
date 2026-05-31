import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  LineIndex, SeverityName, Diagnostic,
  parseHal, parseIni,
  diagnoseHalIntraFile, diagnoseIniIntraFile,
  buildHalSemanticTokens, buildIniSemanticTokens, SemanticTokenItem,
  halDocumentSymbols, iniDocumentSymbols,
  halFoldingRanges, iniFoldingRanges,
} from '@linuxcnc/core';
import { DocumentSymbol, FoldingRange } from 'vscode-languageserver';

export type DocKind = 'hal' | 'ini' | 'gcode';

export function docKind(doc: TextDocument): DocKind | undefined {
  switch (doc.languageId) {
    case 'hal':
      return 'hal';
    case 'linuxcnc-ini':
      return 'ini';
    case 'gcode':
      return 'gcode';
    default:
      break;
  }
  const uri = doc.uri.toLowerCase();
  if (uri.endsWith('.hal')) return 'hal';
  if (uri.endsWith('.ini')) return 'ini';
  if (uri.endsWith('.ngc') || uri.endsWith('.nc') || uri.endsWith('.gcode')) return 'gcode';
  return undefined;
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
}

export function buildDocModel(doc: TextDocument): DocModel {
  const text = doc.getText();
  const lineIndex = new LineIndex(text);
  const kind = docKind(doc);
  const model: DocModel = { kind, text, lineIndex };
  if (kind === 'hal') model.hal = parseHal(text);
  else if (kind === 'ini') model.ini = parseIni(text);
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
  return [];
}

export function computeFoldingRanges(model: DocModel): FoldingRange[] {
  if (model.kind === 'hal') return halFoldingRanges(model.lineIndex);
  if (model.kind === 'ini' && model.ini) return iniFoldingRanges(model.ini, model.lineIndex);
  return [];
}
