import { Range } from 'vscode-languageserver-types';
import { HalFile, IniFile, LineIndex } from '@linuxcnc/core';

/** A parsed HAL file participating in a machine, with its load context. */
export interface HalFileInput {
  uri: string;
  text: string;
  lineIndex: LineIndex;
  hal: HalFile;
  phase: 'pre' | 'postgui' | 'shutdown';
  /** Load order index within the machine (lower = earlier). */
  order: number;
}

export interface IniFileInput {
  uri: string;
  lineIndex: LineIndex;
  ini: IniFile;
}

export interface Loc {
  uri: string;
  range: Range;
}

export interface InstanceInfo {
  /** Instance name (e.g. `and2.0`, `pid.x`, or a singleton like `charge-pump`). */
  name: string;
  /** Base component/module name (e.g. `and2`, `pid`). */
  comp: string;
  loadLoc: Loc;
}

export interface PinRef {
  fullName: string;
  loc: Loc;
  role: 'writer' | 'reader';
  /** HAL type of the pin if known. */
  type?: string;
  /** True when role was determined confidently (explicit arrow or resolved
   *  pin direction). When false, the role is a guess and signal-graph rules
   *  that depend on completeness (no-writer/no-reader) are suppressed. */
  confident?: boolean;
  /** True when the pin's direction was resolved from metadata (not merely
   *  inferred from a `<=`/`=>` arrow). Only direction-resolved writers count
   *  toward the multiple-writers error, which must be statically certain. */
  resolved?: boolean;
}

export interface SignalNode {
  name: string;
  writers: PinRef[];
  readers: PinRef[];
  /** First textual occurrence (used as the "definition"). */
  firstDef?: Loc;
  /** Every occurrence across files. */
  occurrences: Loc[];
  type?: string;
  /** True if set via `sets` (counts as a writer of sorts). */
  setBy?: Loc[];
  /** True if any linked pin's role could not be determined confidently. */
  hasUnresolved?: boolean;
}

export interface MachineModel {
  iniUri?: string;
  ini?: IniFileInput;
  /** INI files pulled in via #INCLUDE (for section/key presence + nav). */
  iniIncludes: IniFileInput[];
  files: HalFileInput[];
  instances: Map<string, InstanceInfo>;
  signals: Map<string, SignalNode>;
  /** Pins explicitly aliased: alias -> original. */
  aliases: Map<string, string>;
  /** True if any file in the machine is a Tcl HAL file or unresolved LIB: file,
   *  in which case some signal checks are suppressed (unknown contributions). */
  hasOpaqueFiles: boolean;
}
