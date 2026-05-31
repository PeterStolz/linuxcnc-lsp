import { LineIndex } from '../common/lineIndex';
import { HalFile, NetStatement, LoadrtStatement, SetpStatement, SetsStatement } from '../hal/ast';
import { HalToken, HalTokenKind } from '../hal/tokens';
import { IniFile } from '../ini/ast';

export const SEMANTIC_TOKEN_TYPES = [
  'keyword', 'variable', 'property', 'namespace', 'enumMember',
  'parameter', 'number', 'string', 'operator', 'type', 'comment',
] as const;
export type SemanticTokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly', 'modification'] as const;

const TYPE_INDEX: Record<SemanticTokenType, number> = Object.fromEntries(
  SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i]),
) as Record<SemanticTokenType, number>;

export interface SemanticTokenItem {
  line: number;
  char: number;
  length: number;
  type: number;
  modifiers: number;
}

class TokenList {
  readonly items: SemanticTokenItem[] = [];
  constructor(private readonly lineIndex: LineIndex) {}
  push(start: number, end: number, type: SemanticTokenType): void {
    const pos = this.lineIndex.positionAt(start);
    const endPos = this.lineIndex.positionAt(end);
    if (endPos.line !== pos.line) return; // skip multi-line spans
    this.items.push({
      line: pos.line,
      char: pos.character,
      length: end - start,
      type: TYPE_INDEX[type],
      modifiers: 0,
    });
  }
  pushTok(t: HalToken | undefined, type: SemanticTokenType): void {
    if (t) this.push(t.start, t.end, type);
  }
  /** For IniRef tokens: color the section name and key separately. */
  pushIniRef(t: HalToken): void {
    if (!t.ini) return;
    this.push(t.ini.sectionStart, t.ini.sectionEnd, 'namespace');
    this.push(t.ini.keyStart, t.ini.keyEnd, 'enumMember');
  }
  finalize(): SemanticTokenItem[] {
    return this.items.sort((a, b) => a.line - b.line || a.char - b.char);
  }
}

function classifyValue(t: HalToken, tl: TokenList): void {
  if (t.kind === HalTokenKind.IniRef) tl.pushIniRef(t);
  else if (t.kind === HalTokenKind.Number) tl.pushTok(t, 'number');
  else if (t.kind === HalTokenKind.String) tl.pushTok(t, 'string');
  else if (t.kind === HalTokenKind.EnvVar) tl.pushTok(t, 'parameter');
  // bare word values are left to TextMate
}

export function buildHalSemanticTokens(file: HalFile, lineIndex: LineIndex): SemanticTokenItem[] {
  const tl = new TokenList(lineIndex);
  for (const stmt of file.statements) {
    tl.pushTok(stmt.commandToken, 'keyword');
    if (stmt.comment) tl.push(stmt.comment.start, stmt.comment.end, 'comment');

    switch (stmt.kind) {
      case 'loadrt': {
        const s = stmt as LoadrtStatement;
        if (s.componentToken?.kind === HalTokenKind.IniRef) tl.pushIniRef(s.componentToken);
        else tl.pushTok(s.componentToken, 'type');
        for (const mp of s.modparams) {
          tl.pushTok(mp.nameToken, 'parameter');
          if (mp.valueToken) classifyValue(mp.valueToken, tl);
        }
        break;
      }
      case 'net': {
        const s = stmt as NetStatement;
        tl.pushTok(s.signalToken, 'variable');
        for (const l of s.links) {
          tl.push(l.pinToken.start, l.pinToken.end, l.pinToken.ini ? 'enumMember' : 'property');
        }
        break;
      }
      case 'setp': {
        const s = stmt as SetpStatement;
        tl.pushTok(s.pinToken, 'property');
        if (s.valueToken) classifyValue(s.valueToken, tl);
        break;
      }
      case 'sets': {
        const s = stmt as SetsStatement;
        tl.pushTok(s.signalToken, 'variable');
        if (s.valueToken) classifyValue(s.valueToken, tl);
        break;
      }
      case 'addf':
      case 'delf':
      case 'initf': {
        const s = stmt as unknown as Record<string, HalToken | undefined>;
        tl.pushTok(s.functionToken, 'property');
        tl.pushTok(s.threadToken, 'variable');
        break;
      }
      default:
        break;
    }
  }
  return tl.finalize();
}

const BOOL_RE = /^(?:true|false|yes|no|on|off)$/i;
const NUM_RE = /^[+-]?(?:0[xXoObB][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)$/;

export function buildIniSemanticTokens(file: IniFile, lineIndex: LineIndex): SemanticTokenItem[] {
  const tl = new TokenList(lineIndex);
  for (const inc of file.includes) {
    tl.push(inc.file.start, inc.file.end, 'string');
  }
  for (const section of file.sections) {
    tl.push(section.name.start, section.name.end, 'namespace');
    for (const entry of section.entries) {
      tl.push(entry.key.start, entry.key.end, 'enumMember');
      const v = entry.value;
      if (v) {
        if (BOOL_RE.test(v.text)) tl.push(v.start, v.end, 'keyword');
        else if (NUM_RE.test(v.text)) tl.push(v.start, v.end, 'number');
      }
    }
  }
  return tl.finalize();
}
