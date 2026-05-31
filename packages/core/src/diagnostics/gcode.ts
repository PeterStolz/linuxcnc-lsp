import { LineIndex } from '../common/lineIndex';
import { GcodeProgram, OStatement } from '../gcode/ast';
import { DiagnosticSink, DiagnosticSinkOptions, SuppressionIndex, Diagnostic } from './types';

/** Intra-file (no project / no file resolution) diagnostics for a G-code
 *  document: structural O-word problems surfaced by the parser. */
export function diagnoseGcodeIntraFile(
  text: string,
  program: GcodeProgram,
  lineIndex: LineIndex,
  opts: DiagnosticSinkOptions = {},
): Diagnostic[] {
  const suppressions = opts.suppressions ?? new SuppressionIndex(text, lineIndex);
  const sink = new DiagnosticSink({ ...opts, suppressions });
  for (const p of program.problems) {
    sink.add(p.code, lineIndex.rangeAt(p.start, p.end), p.message);
  }
  return sink.items;
}

/** Cross-file step: flag `call`s whose subroutine resolves neither in-file nor
 *  via the project's search path. `isResolved(call)` is supplied by the server
 *  (it owns file-system / project access). Calls with a dynamic label (computed
 *  / indirect) are never flagged — they cannot be checked statically. */
export function diagnoseGcodeUnresolvedCalls(
  text: string,
  program: GcodeProgram,
  lineIndex: LineIndex,
  isResolved: (call: OStatement) => boolean,
  opts: DiagnosticSinkOptions = {},
): Diagnostic[] {
  const suppressions = opts.suppressions ?? new SuppressionIndex(text, lineIndex);
  const sink = new DiagnosticSink({ ...opts, suppressions });
  for (const call of program.calls) {
    if (call.oword.key === undefined) continue; // dynamic label — unverifiable
    if (isResolved(call)) continue;
    sink.add(
      'gcode.call.unknownSub',
      lineIndex.rangeAt(call.oword.start, call.oword.end),
      `Subroutine '${call.oword.raw}' is not defined in this file or found in the subroutine search path.`,
    );
  }
  return sink.items;
}
