// @linuxcnc/metadata — build-time extractors + runtime DB loader/overlay.
export const METADATA_VERSION = '0.1.0';

export * from './types';
export { MetadataIndex } from './db';
export { assembleDB } from './assemble';
export { hoverHal, hoverIni } from './providers/hover';
export {
  completeHal, completeIni, HalCompletionContext, IniCompletionContext,
} from './providers/completion';

// Machine model + cross-file analysis
export * from './model/types';
export { buildMachineModel, resolveInstance, resolvePinDir } from './model/build';
export { crossFileDiagnostics, CrossFileOptions } from './model/diagnostics';
export { definition, references, documentHighlights, locateHal, Located, iniRefsTo } from './model/navigation';
export { prepareRename, rename, PrepareRenameResult } from './model/rename';

import * as fs from 'fs';
import { MetadataIndex } from './db';
import { MetadataDB } from './types';

/** Parse a metadata DB from JSON text. */
export function parseDB(json: string): MetadataIndex {
  return new MetadataIndex(JSON.parse(json) as MetadataDB);
}

/** Load a metadata DB from a JSON file on disk. */
export function loadDBFromFile(file: string): MetadataIndex {
  return parseDB(fs.readFileSync(file, 'utf8'));
}

// Extractors (used by the regenerate-db script and by the server's runtime
// .comp overlay).
export { parseHalDump, parseHalDumpNames, DumpedComponent } from './extractors/halDump';
export { parseCompFile, ParsedComp } from './extractors/comp';
export { parseMan9, ParsedMan9 } from './extractors/man9';
export { extractIniConfig, extractHoming } from './extractors/iniDocs';
export { HAL_COMMANDS } from './extractors/commands';
export { adocToMarkdown, splitSections } from './adoc';

// Convert a parsed workspace .comp into a ComponentDef for the runtime overlay.
import { ParsedComp as _PC } from './extractors/comp';
import { ComponentDef } from './types';
export function compToComponentDef(c: _PC): ComponentDef {
  return {
    name: c.name,
    sources: ['comp'],
    description: c.description,
    pins: c.pins.map((p) => ({ name: p.halname, type: p.type, dir: p.dir, doc: p.doc })),
    params: c.params.map((p) => ({ name: p.halname, type: p.type, dir: p.dir, doc: p.doc })),
    functions: c.functions.map((f) => ({ name: f.name, doc: f.doc })),
    modparams: c.modparams.map((mp) => ({ name: mp.name, doc: mp.doc, default: mp.default })),
    instanceNaming: 'count',
    author: c.author,
    license: c.license,
    seeAlso: c.seeAlso,
  };
}
