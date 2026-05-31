import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { LineIndex } from '../common/lineIndex';
import { resolveSeverity, SeverityName } from './rules';

export type { Diagnostic } from 'vscode-languageserver-types';

export const DIAGNOSTIC_SOURCE = 'linuxcnc';

/** Comment-based suppression: scan for
 *    # linuxcnc-lsp-disable <ruleId,...>            (whole file)
 *    # linuxcnc-lsp-disable-line <ruleId,...>       (this physical line)
 *    # linuxcnc-lsp-disable-next-line <ruleId,...>  (the next physical line)
 *  A rule list of `*` (or empty) suppresses all rules in scope. */
export class SuppressionIndex {
  private fileWide = new Set<string>();
  private fileWideAll = false;
  private perLine = new Map<number, Set<string> | '*'>();

  constructor(text: string, private readonly lineIndex: LineIndex) {
    const re = /(?:#|;)\s*linuxcnc-lsp-disable(-line|-next-line)?\b[ \t]*([^\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const scope = m[1];
      const rules = m[2]
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const all = rules.length === 0 || rules.includes('*');
      const line = this.lineIndex.positionAt(m.index).line;
      if (scope === '-line') this.setLine(line, all, rules);
      else if (scope === '-next-line') this.setLine(line + 1, all, rules);
      else {
        if (all) this.fileWideAll = true;
        else for (const r of rules) this.fileWide.add(r);
      }
    }
  }

  private setLine(line: number, all: boolean, rules: string[]): void {
    if (all) {
      this.perLine.set(line, '*');
      return;
    }
    const existing = this.perLine.get(line);
    if (existing === '*') return;
    const set = existing ?? new Set<string>();
    for (const r of rules) set.add(r);
    this.perLine.set(line, set);
  }

  isSuppressed(ruleId: string, range: Range): boolean {
    if (this.fileWideAll || this.fileWide.has(ruleId)) return true;
    const entry = this.perLine.get(range.start.line);
    if (!entry) return false;
    return entry === '*' || entry.has(ruleId);
  }
}

export interface DiagnosticSinkOptions {
  overrides?: Record<string, SeverityName>;
  suppressions?: SuppressionIndex;
}

/** Collects diagnostics, applying per-rule severity overrides and suppression. */
export class DiagnosticSink {
  readonly items: Diagnostic[] = [];

  constructor(private readonly opts: DiagnosticSinkOptions = {}) {}

  add(
    ruleId: string,
    range: Range,
    message: string,
    extra?: Partial<Pick<Diagnostic, 'relatedInformation' | 'tags' | 'data'>>,
  ): void {
    const severity = resolveSeverity(ruleId, this.opts.overrides);
    if (severity === null) return; // rule disabled
    if (this.opts.suppressions?.isSuppressed(ruleId, range)) return;
    this.items.push({
      range,
      severity,
      code: ruleId,
      source: DIAGNOSTIC_SOURCE,
      message,
      ...extra,
    });
  }
}

export { DiagnosticSeverity };
