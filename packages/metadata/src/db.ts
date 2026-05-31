import { MetadataDB, ComponentDef, PinDef, ParamDef, FuncDef, IniSectionSchema, IniKeyDef } from './types';

/**
 * Wraps a MetadataDB with lookup helpers and supports overlaying components
 * parsed from workspace-local .comp files (custom components).
 */
export class MetadataIndex {
  private overlay = new Map<string, ComponentDef>();

  constructor(private readonly db: MetadataDB) {}

  get source() {
    return this.db.source;
  }

  setOverlay(components: ComponentDef[]): void {
    this.overlay = new Map(components.map((c) => [c.name, c]));
  }

  component(name: string): ComponentDef | undefined {
    return this.overlay.get(name) ?? this.db.components[name];
  }

  /** True if `name` is a known loadable component (documented, dumped, a known
   *  hardware driver, or a workspace .comp), even when it has no extracted pins. */
  hasComponentName(name: string): boolean {
    return (
      this.overlay.has(name) ||
      !!this.db.components[name] ||
      this.db.knownComponentNames.includes(name)
    );
  }

  componentNames(): string[] {
    return [...new Set([...Object.keys(this.db.components), ...this.overlay.keys()])];
  }

  /** Look up a pin by component + instance-relative suffix (or absolute name). */
  pin(componentName: string, suffix: string): PinDef | undefined {
    const c = this.component(componentName);
    return c?.pins.find((p) => normalize(p.name) === normalize(suffix));
  }

  param(componentName: string, suffix: string): ParamDef | undefined {
    const c = this.component(componentName);
    return c?.params.find((p) => normalize(p.name) === normalize(suffix));
  }

  func(componentName: string, suffix: string): FuncDef | undefined {
    const c = this.component(componentName);
    return c?.functions.find((f) => normalize(f.name) === normalize(suffix));
  }

  /** Resolve an absolute builtin pin like `joint.0.home-sw-in` against the
   *  `motion` component's `joint.N.*` / `axis.L.*` templates. */
  builtinPin(fullName: string): { comp: ComponentDef; pin: PinDef } | undefined {
    const motion = this.component('motion');
    if (!motion) return undefined;
    const tmpl = toTemplate(fullName);
    const pin = motion.pins.find((p) => p.name === tmpl);
    return pin ? { comp: motion, pin } : undefined;
  }

  iniSection(name: string): IniSectionSchema | undefined {
    const direct = this.db.iniSections[name];
    if (direct) return direct;
    // Match instanced sections: JOINT_0 -> JOINT_<num>, AXIS_X -> AXIS_<letter>, SPINDLE_0 -> SPINDLE_<num>
    if (/^JOINT_\d+$/i.test(name)) return this.db.iniSections['JOINT_<num>'];
    // Valid LinuxCNC axis letters are X Y Z A B C U V W — NOT a contiguous A..W
    // range (that wrongly excludes X/Y/Z and includes D..T).
    if (/^AXIS_[XYZABCUVW]$/i.test(name)) return this.db.iniSections['AXIS_<letter>'];
    if (/^SPINDLE_\d+$/i.test(name)) return this.db.iniSections['SPINDLE_<num>'];
    return undefined;
  }

  iniKey(section: string, key: string): IniKeyDef | undefined {
    return this.iniSection(section)?.keys[key.toLowerCase()];
  }

  homingDoc(key: string): string | undefined {
    return this.db.homingKeys[key.toUpperCase()];
  }

  isRuntimeConsumed(key: string): boolean {
    return this.db.iniRuntimeConsumedKeys.includes(key);
  }

  command(name: string) {
    return this.db.commands[name];
  }
  allCommands() {
    return Object.values(this.db.commands);
  }
  gcodeWord(code: string) {
    return this.db.gcodeWords[code.toUpperCase()];
  }
  raw(): MetadataDB {
    return this.db;
  }
}

/** Collapse numeric/axis indices to the template form used in motion pins. */
function toTemplate(fullName: string): string {
  return fullName
    .replace(/\b(joint|spindle)\.\d+/g, '$1.N')
    .replace(/\baxis\.[a-w]\b/gi, 'axis.L');
}

function normalize(name: string): string {
  // Treat array indices uniformly: foo-00 ~ foo-# ~ foo-N.
  return name.replace(/\d+/g, '#');
}
