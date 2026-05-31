/** A located substring of the INI document. */
export interface IniSpan {
  text: string;
  start: number;
  end: number;
}

export interface IniEntry {
  key: IniSpan;
  /** Value with surrounding whitespace trimmed; undefined if empty. */
  value?: IniSpan;
  start: number;
  end: number;
}

export interface IniSection {
  /** The section name inside the brackets (e.g. "JOINT_0"). */
  name: IniSpan;
  /** Full `[NAME]` header span. */
  headerStart: number;
  headerEnd: number;
  entries: IniEntry[];
  /** Span from the header to just before the next section (or EOF). */
  start: number;
  end: number;
}

export interface IniInclude {
  file: IniSpan;
  start: number;
  end: number;
}

export interface IniProblem {
  start: number;
  end: number;
  message: string;
  code: string;
}

export interface IniFile {
  sections: IniSection[];
  includes: IniInclude[];
  /** Entries appearing before any section header (invalid). */
  orphanEntries: IniEntry[];
  problems: IniProblem[];
}

/** Case-insensitive lookup of a section by name. */
export function findSection(file: IniFile, name: string): IniSection | undefined {
  const lc = name.toLowerCase();
  return file.sections.find((s) => s.name.text.toLowerCase() === lc);
}

/** All entries in a section whose key matches (case-insensitive). */
export function findEntries(section: IniSection, key: string): IniEntry[] {
  const lc = key.toLowerCase();
  return section.entries.filter((e) => e.key.text.toLowerCase() === lc);
}
