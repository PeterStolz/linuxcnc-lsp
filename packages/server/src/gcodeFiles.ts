// Single source of truth for the file extensions that carry RS274NGC G-code.
// These MUST stay in sync with the `gcode` language's `extensions` in
// packages/client/package.json (`contributes.languages`); a vitest guard asserts
// it. Centralizing them keeps the workspace scan, URI routing, and doc-kind
// detection from ever disagreeing about what counts as G-code.

/** Lowercased extensions VS Code maps to the `gcode` language by default. */
export const GCODE_EXTENSIONS = ['.ngc', '.nc', '.gcode', '.tap'] as const;

/** True when a (lowercased) URI or path ends in a known G-code extension. The
 *  caller passes an already-lowercased string. */
export function isGcodePath(lowerUriOrPath: string): boolean {
  return GCODE_EXTENSIONS.some((ext) => lowerUriOrPath.endsWith(ext));
}
