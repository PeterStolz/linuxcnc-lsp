import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { LineIndex } from '@linuxcnc/core';
import { extractGcode } from '../src/extractors/gcode';
import { loadDBFromFile, hoverGcode, completeGcode, MetadataIndex } from '../src/index';

const G = `
[[gcode:quick-reference-table]]
== G-Code Quick Reference Table
[width="75%",options="header",cols="2^,5<"]
|===
|Code |Description
|<<gcode:g0,G0>>        |Coordinated Motion at Rapid Rate
|<<gcode:g2-g3,G2 G3>>  |Coordinated Helical Motion at Feed Rate
|===

[[gcode:g0]]
== G0 Rapid Move

[source,ngc]
----
G0 <axes>
----

For rapid motion, program 'G0 axes', where all the axis words are optional.

=== Rapid Velocity Rate

The MAX_VELOCITY setting...

[[gcode:g2-g3]]
== G2, G3 Arc Move

[source,ngc]
----
G2 or G3 axes offsets
----

A circular or helical arc is specified using either G2 or G3.
`;

const M = `
== M-Code Quick Reference Table
|===
|<<mcode:m3-m4-m5,M3 M4 M5>> | Spindle Control
|===

[[mcode:m3-m4-m5]]
== M3, M4, M5 Spindle Control

Turn the spindle on clockwise (M3) or counterclockwise (M4).
`;

const O = `
[[sec:set-feed-rate]]
== F: Set Feed Rate

\`Fx\` - set the feed rate to x.

== S: Set Spindle Speed

\`Sx\` - set the spindle speed.
`;

describe('extractGcode', () => {
  const w = extractGcode(G, M, O);

  it('maps codes to titles from the quick-reference table', () => {
    expect(w.G0.title).toBe('Coordinated Motion at Rapid Rate');
    expect(w.G2.title).toContain('Helical');
    expect(w.G3.title).toContain('Helical'); // multi-code row expands
  });

  it('attaches the synopsis + prose from the per-code section', () => {
    expect(w.G0.docMd).toContain('```ngc');
    expect(w.G0.docMd).toContain('G0 <axes>');
    expect(w.G0.docMd).toContain('For rapid motion');
    // stops at the first sub-heading
    expect(w.G0.docMd).not.toContain('Rapid Velocity Rate');
  });

  it('handles M-codes and multi-code M rows', () => {
    expect(w.M3.title).toContain('Spindle');
    expect(w.M4).toBeDefined();
    expect(w.M5.docMd).toContain('clockwise');
  });

  it('clamps an absurd decimal range instead of expanding unbounded (round-3 #2)', () => {
    const t0 = Date.now();
    const w = extractGcode('|<<gcode:x,G0.0-G0.5000000>> |Title', '', '');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(Object.keys(w).length).toBeLessThan(100); // endpoints only, not 5M keys
  });

  it('handles single-letter words from other-code (F/S/T)', () => {
    expect(w.F.title).toBe('Set Feed Rate');
    expect(w.F.docMd).toContain('feed rate');
    expect(w.S.title).toBe('Set Spindle Speed');
  });
});

describe('G-code hover / completion (against the bundled DB)', () => {
  let index: MetadataIndex;
  beforeAll(() => { index = loadDBFromFile(path.resolve(__dirname, '../data/db.json')); });

  const hover = (text: string, marker: string) => {
    const off = text.indexOf(marker) + Math.floor(marker.length / 2);
    const h = hoverGcode(text, new LineIndex(text), off, index);
    return h && typeof h.contents === 'object' && 'value' in h.contents ? (h.contents as { value: string }).value : '';
  };
  const labelsAt = (text: string) => completeGcode(text, new LineIndex(text), text.length, index).map((i) => i.label);

  it('hovers a G code with its documented title', () => {
    expect(hover('G1 X1', 'G1')).toContain('Coordinated Motion at Feed Rate');
  });

  it('hovers an M code', () => {
    expect(hover('M3 S1000', 'M3')).toContain('Spindle');
  });

  it('explains an axis word', () => {
    expect(hover('G1 X1.5', 'X1.5')).toContain('X axis');
  });

  it('explains a well-known numbered parameter', () => {
    expect(hover('G0 X#5220', '#5220')).toContain('coordinate system number');
  });

  it('explains an O-word keyword', () => {
    expect(hover('o100 sub', 'sub')).toContain('subroutine');
  });

  it('completes G codes from a partial', () => {
    const ls = labelsAt('G');
    expect(ls).toContain('G0');
    expect(ls).toContain('G1');
    expect(ls.every((l) => l.startsWith('G'))).toBe(true);
  });

  it('completes M codes', () => {
    expect(labelsAt('M')).toContain('M3');
  });

  it('completes O-word keywords after an O label', () => {
    const ls = labelsAt('o100 ');
    expect(ls).toContain('sub');
    expect(ls).toContain('while');
  });
});
