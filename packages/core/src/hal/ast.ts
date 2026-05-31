import { HalToken } from './tokens';

/** The set of halcmd commands recognized by the parser (lowercased). */
export const HAL_COMMANDS = [
  'loadrt', 'unloadrt', 'loadusr', 'unloadusr', 'unload', 'waitusr',
  'newsig', 'delsig', 'sets', 'gets', 'stype', 'ptype', 'getp', 'setp',
  'linkps', 'linksp', 'linkpp', 'net', 'unlinkp',
  'addf', 'delf', 'initf', 'start', 'stop',
  'show', 'list', 'save', 'source', 'alias', 'unalias',
  'lock', 'unlock', 'status', 'help', 'echo', 'unecho', 'print', 'debug', 'item',
  'quit', 'exit',
] as const;

export type HalCommand = (typeof HAL_COMMANDS)[number];

export const HAL_COMMAND_SET: ReadonlySet<string> = new Set(HAL_COMMANDS);

/** Obsolete commands that should be steered toward `net`. */
export const HAL_OBSOLETE = new Set(['linkps', 'linksp', 'linkpp', 'newsig']);

export type StatementKind =
  | 'loadrt' | 'loadusr' | 'unloadrt' | 'unloadusr' | 'unload' | 'waitusr'
  | 'addf' | 'delf' | 'initf'
  | 'net' | 'setp' | 'sets' | 'getp' | 'gets'
  | 'linkps' | 'linksp' | 'linkpp' | 'unlinkp'
  | 'newsig' | 'delsig'
  | 'alias' | 'unalias' | 'source'
  | 'generic' // start/stop/show/list/save/status/lock/unlock/help/echo/...
  | 'error';

export interface BaseStatement {
  kind: StatementKind;
  /** The command keyword token (absent for error statements with no command). */
  commandToken?: HalToken;
  command?: string; // lowercased command
  start: number;
  end: number;
  comment?: HalToken;
}

export interface ModParam {
  nameToken: HalToken;
  valueToken?: HalToken;
}

export interface LoadrtStatement extends BaseStatement {
  kind: 'loadrt';
  componentToken?: HalToken; // base component name (may be an IniRef)
  modparams: ModParam[];
  /** Instance names from names=a,b,c (split & trimmed). */
  names?: string[];
  namesToken?: HalToken;
  count?: number;
  countToken?: HalToken;
  /** Raw config="..." string token, if present (Mesa). */
  configToken?: HalToken;
}

export interface LoadusrStatement extends BaseStatement {
  kind: 'loadusr';
  flags: HalToken[];
  commandArgs: HalToken[];
}

export interface NetLink {
  pinToken: HalToken;
  /** Arrow in effect for this pin: '<=' pin is source, '=>' pin is sink. */
  arrow?: '<=' | '=>';
}

export interface NetStatement extends BaseStatement {
  kind: 'net';
  signalToken?: HalToken;
  links: NetLink[];
}

export interface SetpStatement extends BaseStatement {
  kind: 'setp';
  pinToken?: HalToken;
  valueToken?: HalToken; // literal, IniRef or EnvVar
}

export interface SetsStatement extends BaseStatement {
  kind: 'sets';
  signalToken?: HalToken;
  valueToken?: HalToken;
}

export interface AddfStatement extends BaseStatement {
  kind: 'addf' | 'delf' | 'initf';
  functionToken?: HalToken;
  threadToken?: HalToken;
  positionToken?: HalToken;
}

export interface LinkStatement extends BaseStatement {
  kind: 'linkps' | 'linksp' | 'linkpp';
  firstToken?: HalToken;
  secondToken?: HalToken;
  arrow?: '<=' | '=>';
}

export interface UnlinkpStatement extends BaseStatement {
  kind: 'unlinkp';
  pinToken?: HalToken;
}

export interface NewsigStatement extends BaseStatement {
  kind: 'newsig';
  signalToken?: HalToken;
  typeToken?: HalToken;
}

export interface SimpleSignalStatement extends BaseStatement {
  kind: 'delsig' | 'gets' | 'getp';
  targetToken?: HalToken;
}

export interface AliasStatement extends BaseStatement {
  kind: 'alias' | 'unalias';
  aliasKind?: 'pin' | 'param';
  originalToken?: HalToken;
  aliasToken?: HalToken;
}

export interface SourceStatement extends BaseStatement {
  kind: 'source';
  fileToken?: HalToken;
}

export interface GenericStatement extends BaseStatement {
  kind: 'generic';
  args: HalToken[];
}

export interface ErrorStatement extends BaseStatement {
  kind: 'error';
  tokens: HalToken[];
  message: string;
}

export type HalStatement =
  | LoadrtStatement | LoadusrStatement | NetStatement | SetpStatement | SetsStatement
  | AddfStatement | LinkStatement | UnlinkpStatement | NewsigStatement
  | SimpleSignalStatement | AliasStatement | SourceStatement | GenericStatement
  | ErrorStatement | (BaseStatement & { kind: 'unloadrt' | 'unloadusr' | 'unload' | 'waitusr'; args: HalToken[] });

export interface HalFile {
  statements: HalStatement[];
}

/** Collect every IniRef token referenced anywhere in a statement. */
export function collectIniRefs(stmt: HalStatement): HalToken[] {
  const out: HalToken[] = [];
  const visit = (t?: HalToken): void => {
    if (t && t.ini) out.push(t);
  };
  const s = stmt as unknown as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    const v = s[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && 'kind' in item && 'start' in item) visit(item as HalToken);
        else if (item && typeof item === 'object' && 'pinToken' in item) visit((item as NetLink).pinToken);
        else if (item && typeof item === 'object' && 'valueToken' in item) visit((item as ModParam).valueToken);
      }
    } else if (v && typeof v === 'object' && 'kind' in v && 'start' in v && 'end' in v) {
      visit(v as HalToken);
    }
  }
  return out;
}
