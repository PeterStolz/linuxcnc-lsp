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

// G-code
export { tokenizeGcode, gcodeTokenAt, GcodeToken, GcodeTokenKind, O_KEYWORDS } from './gcode/tokenizer';
export { parseGcode, classifyOword } from './gcode/parser';
export * from './gcode/ast';
export { formatGcode, GcodeFormatOptions } from './gcode/format';
export {
  gcodeOwordAt, gcodeDefinition, gcodeReferences, gcodeDocumentHighlights,
} from './gcode/navigation';

// Diagnostics
export { RULES, RuleId, resolveSeverity, SeverityName } from './diagnostics/rules';
export {
  Diagnostic, DiagnosticSeverity, DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, DIAGNOSTIC_SOURCE,
} from './diagnostics/types';
export { diagnoseHalIntraFile } from './diagnostics/hal';
export { diagnoseIniIntraFile } from './diagnostics/ini';
export { diagnoseGcodeIntraFile, diagnoseGcodeUnresolvedCalls } from './diagnostics/gcode';

// Providers
export {
  SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, SemanticTokenItem,
  buildHalSemanticTokens, buildIniSemanticTokens,
} from './providers/semanticTokens';
export { halDocumentSymbols, iniDocumentSymbols, gcodeDocumentSymbols } from './providers/documentSymbol';
export { halFoldingRanges, iniFoldingRanges, gcodeFoldingRanges } from './providers/folding';
