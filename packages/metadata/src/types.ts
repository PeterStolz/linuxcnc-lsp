// Shape of the bundled metadata database extracted from a pinned LinuxCNC
// source checkout (+ ground-truth structural dump from a sim build).

export type HalType = 'bit' | 'float' | 's32' | 'u32' | 's64' | 'u64' | 'port' | 'unknown';
export type PinDir = 'in' | 'out' | 'io';
export type ParamDir = 'rw' | 'ro';

/** Source(s) a piece of metadata was derived from. */
export type MetaSource = 'comp' | 'man9' | 'halrun' | 'curated' | 'ini-doc' | 'gcode-doc';

export interface PinDef {
  /** For instanced components this is the pin suffix relative to an instance
   *  (e.g. `gain`, `position-fb`). For components with `absolute: true` it is a
   *  full HAL name template with `N` for a numeric index and `L` for an axis
   *  letter (e.g. `joint.N.home-sw-in`, `axis.L.pos-cmd`). */
  name: string;
  type: HalType;
  dir: PinDir;
  doc?: string;
  /** Free-text condition on existence (e.g. "step type 0 only"). */
  condition?: string;
}

export interface ParamDef {
  name: string;
  type: HalType;
  dir: ParamDir;
  doc?: string;
  condition?: string;
}

export interface FuncDef {
  /** For per-instance functions, the suffix relative to the instance (e.g.
   *  `do-pid-calcs`, or `''` when the instance itself is the function as for
   *  `and2.0`). For `global` functions, the full HAL function name (e.g.
   *  `stepgen.make-pulses`, `motion-controller`). */
  name: string;
  /** True when the function is not per-instance (operates on all channels). */
  global?: boolean;
  fp?: boolean;
  doc?: string;
}

export interface ModparamDef {
  name: string;
  type?: string;
  doc?: string;
  default?: string;
}

export type InstanceNaming = 'count' | 'names' | 'singleton' | 'personality' | 'mesa' | 'unknown';

export interface ComponentDef {
  /** Module name as used in `loadrt` (e.g. `and2`, `pid`, `hostmot2`). */
  name: string;
  sources: MetaSource[];
  description?: string;
  descriptionMd?: string;
  pins: PinDef[];
  params: ParamDef[];
  functions: FuncDef[];
  modparams: ModparamDef[];
  instanceNaming: InstanceNaming;
  /** When true, pin/param names are full HAL templates (e.g. motion's
   *  `joint.N.*`), not instance-relative suffixes. */
  absolute?: boolean;
  author?: string;
  license?: string;
  seeAlso?: string;
  notes?: string;
  examples?: string;
  /** Man-page section (usually 9) for cross-linking. */
  manSection?: number;
}

export interface IniKeyDef {
  key: string;
  type?: string;
  doc?: string;
  docMd?: string;
  example?: string;
  deprecated?: boolean;
}

export interface IniSectionSchema {
  /** Canonical section name; may contain `N`/`L` placeholders for instanced
   *  sections like JOINT_N, AXIS_L, SPINDLE_N. */
  name: string;
  doc?: string;
  docMd?: string;
  keys: Record<string, IniKeyDef>;
  /** True for sections like JOINT_0..N / AXIS_X..W / SPINDLE_0..N. */
  instanced?: boolean;
}

export interface GcodeWordDef {
  code: string; // e.g. "G0", "M3"
  title?: string;
  docMd?: string;
}

export interface CommandDef {
  name: string;
  signature: string;
  doc?: string;
}

export interface MetadataSourceInfo {
  repo: string;
  commit: string;
  describe: string;
  lcncVersion: string;
  generatedAt?: string;
}

export interface MetadataDB {
  source: MetadataSourceInfo;
  components: Record<string, ComponentDef>;
  /** All known loadable component/module names (incl. ones with no extracted
   *  pins, e.g. hardware drivers), so "unknown component" only fires for names
   *  that truly do not exist in this LinuxCNC version. */
  knownComponentNames: string[];
  iniSections: Record<string, IniSectionSchema>;
  /** Homing INI key -> rendered markdown of its docs section. */
  homingKeys: Record<string, string>;
  /** INI keys read directly by core LinuxCNC (so absence in HAL is not "unreferenced"). */
  iniRuntimeConsumedKeys: string[];
  gcodeWords: Record<string, GcodeWordDef>;
  commands: Record<string, CommandDef>;
}

export function emptyDB(source: MetadataSourceInfo): MetadataDB {
  return {
    source,
    components: {},
    knownComponentNames: [],
    iniSections: {},
    homingKeys: {},
    iniRuntimeConsumedKeys: [],
    gcodeWords: {},
    commands: {},
  };
}
