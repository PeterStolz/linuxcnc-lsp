// @linuxcnc/core — pure analysis engine (no vscode / LSP runtime deps).
export const CORE_VERSION = '0.1.0';

// Text utilities
export { LineIndex } from './common/lineIndex';

// HAL
export { tokenizeHal } from './hal/tokenizer';
export {
  HalToken, HalTokenKind, HalLogicalLine, IniRefParts,
} from './hal/tokens';
export { parseHal } from './hal/parser';
export * from './hal/ast';

// INI
export { parseIni } from './ini/parser';
export * from './ini/ast';

// Diagnostics
export { RULES, RuleId, resolveSeverity, SeverityName } from './diagnostics/rules';
export {
  Diagnostic, DiagnosticSeverity, DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, DIAGNOSTIC_SOURCE,
} from './diagnostics/types';
export { diagnoseHalIntraFile } from './diagnostics/hal';
export { diagnoseIniIntraFile } from './diagnostics/ini';

// Providers
export {
  SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, SemanticTokenItem,
  buildHalSemanticTokens, buildIniSemanticTokens,
} from './providers/semanticTokens';
export { halDocumentSymbols, iniDocumentSymbols } from './providers/documentSymbol';
export { halFoldingRanges, iniFoldingRanges } from './providers/folding';
