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
