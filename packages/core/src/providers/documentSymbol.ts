import { DocumentSymbol, SymbolKind, Range } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { HalFile, LoadrtStatement, NetStatement, NewsigStatement } from '../hal/ast';
import { HalToken } from '../hal/tokens';
import { IniFile } from '../ini/ast';

function sym(
  name: string,
  detail: string,
  kind: SymbolKind,
  range: Range,
  selectionRange: Range,
  children?: DocumentSymbol[],
): DocumentSymbol {
  return { name, detail, kind, range, selectionRange, children };
}

export function halDocumentSymbols(file: HalFile, lineIndex: LineIndex): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  const seenSignals = new Set<string>();
  const threads = new Map<string, { token: HalToken; funcs: DocumentSymbol[] }>();

  const addSignal = (token: HalToken | undefined, stmtRange: Range): void => {
    if (!token || seenSignals.has(token.text)) return;
    seenSignals.add(token.text);
    const r = lineIndex.rangeAt(token.start, token.end);
    out.push(sym(token.text, 'signal', SymbolKind.Variable, stmtRange, r));
  };

  for (const stmt of file.statements) {
    const stmtRange = lineIndex.rangeAt(stmt.start, stmt.end);
    switch (stmt.kind) {
      case 'loadrt': {
        const s = stmt as LoadrtStatement;
        if (!s.componentToken) break;
        // Cap materialized children: count= is clamped at parse time, but never
        // build more than a handful of outline nodes regardless.
        const SYMBOL_CAP = 256;
        const total = s.names ? s.names.length : (s.count ?? 0);
        const instances = s.names
          ? s.names.slice(0, SYMBOL_CAP)
          : (s.count ? Array.from({ length: Math.min(s.count, SYMBOL_CAP) }, (_, i) => `${s.componentToken!.text}.${i}`) : []);
        const children = instances.map((inst) =>
          sym(inst, 'instance', SymbolKind.Object, stmtRange, lineIndex.rangeAt(s.componentToken!.start, s.componentToken!.end)),
        );
        out.push(
          sym(
            s.componentToken.text,
            total ? `${total} instance(s)` : 'component',
            SymbolKind.Module,
            stmtRange,
            lineIndex.rangeAt(s.componentToken.start, s.componentToken.end),
            children.length ? children : undefined,
          ),
        );
        break;
      }
      case 'net':
        addSignal((stmt as NetStatement).signalToken, stmtRange);
        break;
      case 'newsig':
        addSignal((stmt as NewsigStatement).signalToken, stmtRange);
        break;
      case 'addf':
      case 'initf': {
        const s = stmt as unknown as Record<string, HalToken | undefined>;
        if (s.functionToken && s.threadToken) {
          const t = threads.get(s.threadToken.text) ?? { token: s.threadToken, funcs: [] };
          t.funcs.push(
            sym(
              s.functionToken.text,
              'function',
              SymbolKind.Function,
              stmtRange,
              lineIndex.rangeAt(s.functionToken.start, s.functionToken.end),
            ),
          );
          threads.set(s.threadToken.text, t);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const [name, t] of threads) {
    const r = lineIndex.rangeAt(t.token.start, t.token.end);
    out.push(sym(name, `${t.funcs.length} function(s)`, SymbolKind.Namespace, r, r, t.funcs));
  }

  return out;
}

export function iniDocumentSymbols(file: IniFile, lineIndex: LineIndex): DocumentSymbol[] {
  return file.sections.map((section) => {
    const headerRange = lineIndex.rangeAt(section.headerStart, section.headerEnd);
    // Trim a trailing newline only when one is actually present (else the last
    // section in a file without a trailing newline would end before its own
    // entries, producing child ranges outside the parent).
    let endOff = section.end;
    const last = lineIndex.text.charCodeAt(endOff - 1);
    if (endOff > section.start && (last === 10 || last === 13)) endOff--;
    endOff = Math.max(endOff, section.headerEnd);
    const fullRange = lineIndex.rangeAt(section.start, endOff);
    const children = section.entries.map((e) =>
      sym(
        e.key.text,
        e.value?.text ?? '',
        SymbolKind.Property,
        lineIndex.rangeAt(e.start, e.end),
        lineIndex.rangeAt(e.key.start, e.key.end),
      ),
    );
    return sym(section.name.text, '', SymbolKind.Namespace, fullRange, headerRange, children);
  });
}
