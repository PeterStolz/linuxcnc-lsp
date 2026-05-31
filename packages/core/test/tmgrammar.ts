// Test helper: tokenize text with the shipped TextMate grammars using the same
// Oniguruma engine VSCode uses, so grammar tests reflect real highlighting.
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

const GRAMMAR_DIR = path.resolve(__dirname, '../../client/grammars');

const SCOPE_TO_FILE: Record<string, string> = {
  'source.hal': path.join(GRAMMAR_DIR, 'hal.tmLanguage.json'),
  'source.linuxcnc-ini': path.join(GRAMMAR_DIR, 'ini.tmLanguage.json'),
  'source.gcode': path.join(GRAMMAR_DIR, 'gcode.tmLanguage.json'),
};

let registry: vsctm.Registry | undefined;

function getRegistry(): vsctm.Registry {
  if (registry) return registry;
  const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
  const wasmBin = fs.readFileSync(wasmPath).buffer;
  const onigLib = oniguruma.loadWASM(wasmBin as ArrayBuffer).then(() => ({
    createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
    createOnigString: (s: string) => new oniguruma.OnigString(s),
  }));
  registry = new vsctm.Registry({
    onigLib,
    loadGrammar: async (scopeName: string) => {
      const file = SCOPE_TO_FILE[scopeName];
      if (!file) return null;
      const data = fs.readFileSync(file, 'utf8');
      return vsctm.parseRawGrammar(data, file);
    },
  });
  return registry;
}

export interface ScopedToken {
  text: string;
  scopes: string[];
}

/** Tokenize a single line; returns each token's text and full scope stack. */
export async function tokenizeLine(scopeName: string, line: string): Promise<ScopedToken[]> {
  const grammar = await getRegistry().loadGrammar(scopeName);
  if (!grammar) throw new Error(`grammar not found: ${scopeName}`);
  const result = grammar.tokenizeLine(line, vsctm.INITIAL);
  return result.tokens.map((t) => ({
    text: line.substring(t.startIndex, t.endIndex),
    scopes: t.scopes,
  }));
}

/** True if any token whose text === `text` carries a scope containing `scope`. */
export function hasScope(tokens: ScopedToken[], text: string, scope: string): boolean {
  return tokens.some(
    (t) => t.text === text && t.scopes.some((s) => s.includes(scope)),
  );
}

/** Find the token covering a substring and assert it has the given scope. */
export function scopeOfText(tokens: ScopedToken[], text: string): string[] {
  const t = tokens.find((tok) => tok.text === text);
  return t ? t.scopes : [];
}
