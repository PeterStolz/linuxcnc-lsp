import { Range } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { HalFile, HalStatement } from '../hal/ast';
import { HalToken } from '../hal/tokens';
import { DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, Diagnostic } from './types';

/** Intra-file (no metadata, no cross-file) diagnostics for a HAL document. */
export function diagnoseHalIntraFile(
  text: string,
  file: HalFile,
  lineIndex: LineIndex,
  opts: DiagnosticSinkOptions = {},
): Diagnostic[] {
  const suppressions = opts.suppressions ?? new SuppressionIndex(text, lineIndex);
  const sink = new DiagnosticSink({ ...opts, suppressions });

  for (const stmt of file.statements) {
    checkStatement(stmt, lineIndex, sink);
  }
  return sink.items;
}

function rangeOf(lineIndex: LineIndex, t: HalToken | undefined, stmt: HalStatement): Range {
  if (t) return lineIndex.rangeAt(t.start, t.end);
  return lineIndex.rangeAt(stmt.start, stmt.end);
}

function checkStatement(stmt: HalStatement, lineIndex: LineIndex, sink: DiagnosticSink): void {
  const s = stmt as unknown as Record<string, unknown>;
  const cmdRange = rangeOf(lineIndex, stmt.commandToken, stmt);

  const malformed = (msg: string, t?: HalToken): void =>
    sink.add('hal.syntax.malformedStatement', rangeOf(lineIndex, t, stmt), msg);

  switch (stmt.kind) {
    case 'error':
      sink.add('hal.syntax.unknownCommand', lineIndex.rangeAt(stmt.start, stmt.end), (s.message as string) ?? 'Syntax error');
      return;
    case 'loadrt':
      if (!s.componentToken) malformed('loadrt requires a component name');
      break;
    case 'loadusr':
      if ((s.commandArgs as unknown[]).length === 0) malformed('loadusr requires a command to run');
      break;
    case 'net':
      if (!s.signalToken) malformed('net requires a signal name');
      else if ((s.links as unknown[]).length === 0)
        malformed('net requires at least one pin to link', stmt.commandToken);
      break;
    case 'setp':
      if (!s.pinToken) malformed('setp requires a pin/parameter name');
      else if (!s.valueToken) malformed('setp requires a value', s.pinToken as HalToken);
      break;
    case 'sets':
      if (!s.signalToken) malformed('sets requires a signal name');
      else if (!s.valueToken) malformed('sets requires a value', s.signalToken as HalToken);
      break;
    case 'addf':
    case 'delf':
    case 'initf':
      if (!s.functionToken) malformed(`${stmt.command} requires a function name`);
      else if (!s.threadToken) malformed(`${stmt.command} requires a thread name`, s.functionToken as HalToken);
      break;
    case 'linkps':
    case 'linksp':
    case 'linkpp':
      if (!s.firstToken || !s.secondToken) malformed(`${stmt.command} requires two operands`);
      break;
    case 'unlinkp':
      if (!s.pinToken) malformed('unlinkp requires a pin name');
      break;
    case 'newsig':
      if (!s.signalToken) malformed('newsig requires a signal name');
      else if (!s.typeToken) malformed('newsig requires a type', s.signalToken as HalToken);
      break;
    case 'delsig':
    case 'gets':
    case 'getp':
      if (!s.targetToken) malformed(`${stmt.command} requires a name`);
      break;
    case 'alias':
      if (!s.aliasKind) malformed("alias requires 'pin' or 'param'", cmdRangeToken(stmt));
      else if (!s.originalToken || !s.aliasToken) malformed('alias requires an original name and an alias');
      break;
    case 'unalias':
      if (!s.aliasKind) malformed("unalias requires 'pin' or 'param'", cmdRangeToken(stmt));
      else if (!s.aliasToken) malformed('unalias requires an alias name');
      break;
    case 'source':
      if (!s.fileToken) malformed('source requires a file name');
      break;
    default:
      break;
  }
  void cmdRange;
}

function cmdRangeToken(stmt: HalStatement): HalToken | undefined {
  return stmt.commandToken;
}
