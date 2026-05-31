import { DiagnosticSeverity } from 'vscode-languageserver-types';

/** Every diagnostic rule the analyzer can emit, with a default severity and a
 *  one-line description (surfaced in settings UI / docs). `null` severity means
 *  the rule is off by default. */
export interface RuleDef {
  id: string;
  defaultSeverity: DiagnosticSeverity | null;
  description: string;
}

const E = DiagnosticSeverity.Error;
const W = DiagnosticSeverity.Warning;
const I = DiagnosticSeverity.Information;
const H = DiagnosticSeverity.Hint;

export const RULES: readonly RuleDef[] = [
  // --- HAL syntax (intra-file) ---
  { id: 'hal.syntax.unknownCommand', defaultSeverity: E, description: 'A word at the start of a line is not a known halcmd command.' },
  { id: 'hal.syntax.unrecognizedLine', defaultSeverity: H, description: 'A line could not be parsed and does not start with a word (e.g. a wrapped comment fragment); too ambiguous to flag as an error.' },
  { id: 'hal.syntax.malformedStatement', defaultSeverity: E, description: 'A command is missing required arguments.' },
  // --- INI syntax (intra-file) ---
  { id: 'ini.syntax.entryOutsideSection', defaultSeverity: E, description: 'A KEY = VALUE entry appears before any [SECTION].' },
  { id: 'ini.syntax.malformedLine', defaultSeverity: E, description: 'A line is neither a section header nor a KEY = VALUE entry.' },
  { id: 'ini.syntax.invalidSection', defaultSeverity: E, description: 'A section name is not a valid identifier.' },
  { id: 'ini.syntax.trailingHeaderText', defaultSeverity: W, description: 'Unexpected text after a [SECTION] header.' },
  { id: 'ini.syntax.duplicateKey', defaultSeverity: H, description: 'A key is defined more than once in a section with conflicting values (LinuxCNC uses the first; the later value is silently ignored).' },
  { id: 'ini.syntax.redundantKey', defaultSeverity: H, description: 'A key is defined more than once in a section with the same value (redundant; LinuxCNC uses the first).' },

  // --- Semantic / cross-file (emitted in later milestones) ---
  { id: 'hal.comp.unknownComponent', defaultSeverity: W, description: 'loadrt references a component not in the metadata DB or workspace.' },
  { id: 'hal.pin.unknownPin', defaultSeverity: W, description: 'A pin/param is not produced by any loaded component.' },
  { id: 'hal.param.readonlyParamSet', defaultSeverity: E, description: 'setp targets a read-only parameter.' },
  { id: 'hal.signal.multipleWriters', defaultSeverity: E, description: 'A signal is driven by more than one output pin.' },
  { id: 'hal.signal.noWriter', defaultSeverity: H, description: 'A signal has readers but no writer (advisory: the static model cannot see writers in userspace/Tcl components).' },
  { id: 'hal.signal.noReader', defaultSeverity: H, description: 'A signal is written but never read.' },
  { id: 'hal.signal.typeConflict', defaultSeverity: E, description: 'Pins of different HAL types are linked to one signal.' },
  { id: 'hal.iniref.sectionMissing', defaultSeverity: E, description: 'A [SECTION]KEY reference names a section absent from the INI.' },
  { id: 'hal.iniref.keyMissing', defaultSeverity: E, description: 'A [SECTION]KEY reference names a key absent from the INI section.' },
  { id: 'ini.key.unreferenced', defaultSeverity: H, description: 'An INI key is not referenced by any HAL file or known core consumer.' },
  { id: 'ini.value.typeMismatch', defaultSeverity: W, description: 'An INI value does not match the documented type (e.g. a non-number for a real/int key).' },
  { id: 'ini.value.enumMismatch', defaultSeverity: W, description: 'An INI value is not one of the documented allowed values for an enum key.' },
] as const;

export type RuleId = (typeof RULES)[number]['id'];

const RULE_MAP = new Map(RULES.map((r) => [r.id, r]));

export type SeverityName = 'error' | 'warning' | 'information' | 'hint' | 'off';

const NAME_TO_SEVERITY: Record<SeverityName, DiagnosticSeverity | null> = {
  error: E,
  warning: W,
  information: I,
  hint: H,
  off: null,
};

/** Resolve the effective severity for a rule given user overrides (by id). */
export function resolveSeverity(
  ruleId: string,
  overrides?: Record<string, SeverityName>,
): DiagnosticSeverity | null {
  const override = overrides?.[ruleId];
  if (override && override in NAME_TO_SEVERITY) return NAME_TO_SEVERITY[override];
  return RULE_MAP.get(ruleId)?.defaultSeverity ?? W;
}
