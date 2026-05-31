# Screenshot capture guide

The marketplace listing and READMEs reference images under
`packages/client/images/`. This guide says **exactly** what to capture, from a
reproducible demo config (`docs/demo/`), so the shots are consistent and re-do-able.

## Why these shots

The persona/UX audit found the listing's #1 weakness is that a visitor can't tell
*what the extension does* — it's text-only with no proof. Each shot below answers
one visitor question in one glance. The first three are **required** (they carry
the listing); the rest are nice-to-have.

## Setup (once)

1. Open the `docs/demo/` folder in VS Code with this extension installed
   (`code docs/demo`). Opening the folder — not a single file — is what enables
   the cross-file features.
2. Theme: use **Dark+ (default dark)** for contrast and consistency. Hide the
   minimap (`"editor.minimap.enabled": false`) and breadcrumbs noise as noted
   per shot.
3. Zoom the editor font to ~16px (`Cmd/Ctrl +`) so text is legible when the image
   is scaled down on the marketplace.
4. Crop tight to the relevant region — never a full 1440p desktop. Target width
   ~1200px. Export PNG (lossless). For GIFs keep < 2 MB and < 15 s.
5. Save into `packages/client/images/` using the exact filenames below.

> The exact squiggles depend on the bundled metadata DB (LinuxCNC 2.10.0~pre1).
> If a line doesn't flag as described, tweak the demo file and update this guide.

---

## 1. `hero-diagnostics.png` — REQUIRED (the one that sells it)

**Question answered:** "What does this actually do for me?"
**Scene:** `tabletop.hal`, the line `setp pid.0.Igain [JOINT_0]IGAIN`.

- This is the **cross-file** check — the unique differentiator. `[JOINT_0]IGAIN`
  isn't defined in `tabletop.ini`, so it gets a red squiggle
  (`hal.iniref.keyMissing`). Put the cursor on `[JOINT_0]IGAIN` and **hover** it so
  the tooltip is visible: *"INI variable [JOINT_0]IGAIN is not defined in tabletop.ini"*.
- Include the editor gutter so the red error marker shows, and keep the
  `setp pid.0.output 1` line below in frame — it carries a second squiggle
  (`hal.param.readonlyParamSet`, "it is an output pin (read-only)") to show breadth.
- Crop to those ~6 lines + the hover popover. Don't show the whole file.

> Verified: these two lines are the only diagnostics this demo emits. Pin/param
> *name* typos are **not** flagged (the extension validates components, INI refs,
> read-only params, and the signal graph — not pin spelling), so don't stage a
> misspelled-pin shot; it won't squiggle.

**Caption:** *Cross-file checks catch bad references as you type — before the machine refuses to start.*
**Alt text:** `A HAL file with a red squiggle under an INI reference that is not defined, with a hover tooltip explaining the error.`
**Optional GIF version (`hero-diagnostics.gif`):** start from `[JOINT_0]PGAIN`
(valid, no squiggle), change it to `[JOINT_0]IGAIN`, let the squiggle appear, hover.
Motion makes "as you type" obvious. If you ship the GIF, still keep the PNG as fallback.

---

## 2. `hover-docs.png` — REQUIRED

**Question answered:** "Do I have to keep the LinuxCNC manual open in another tab?"
**Scene:** hover a symbol whose docs come from the LinuxCNC source.

- Best single shot: open `nc_files/facing.ngc` and hover `G38.2` (rich probe doc),
  **or** in `tabletop.hal` hover the `pid` component on the `loadrt pid` line
  (shows pins/params). Pick whichever renders the cleaner tooltip.
- Capture the hover popover fully, with 1–2 lines of code above it for context.

**Caption:** *Hover any component, pin, INI key, or G/M-code for docs pulled straight from the LinuxCNC source.*
**Alt text:** `Editor hover tooltip showing LinuxCNC documentation for a G-code word.`

---

## 3. `gcode-subroutines.png` — REQUIRED (the newest differentiator)

**Question answered:** "Is the G-code support real, or just colors?"
**Scene:** `nc_files/facing.ngc` with the **Outline** view open (Explorer sidebar,
Outline section) and the editor showing the `o<probe> call` / `o<rough> repeat` blocks.

- Expand the Outline so `o<probe>` (from the called file) and the structure show.
- Put the cursor on `o<probe> call`; if you can capture the go-to-definition peek
  (Alt/Cmd-click → inline peek into `subs/probe.ngc`), even better — that proves
  *cross-file* subroutine resolution in one image.
- Show the folding chevrons in the gutter next to `o<rough> repeat`.

**Caption:** *G-code O-word subroutines: outline, cross-file go-to-definition, folding, formatting, and structural checks.*
**Alt text:** `A G-code file with an outline of its subroutines and a peek into a subroutine defined in another file.`

---

## 4. `goto-definition.png` — optional (integrator moat)

**Scene:** `tabletop.hal`, `setp pid.0.Pgain [JOINT_0]PGAIN` (this reference is
valid — PGAIN is defined). Trigger **Peek Definition** (Alt/Opt+F12) on
`[JOINT_0]PGAIN` so the inline peek shows the `PGAIN = 50.0` line from `tabletop.ini`.
**Caption:** *Jump from a HAL `[SECTION]KEY` to its INI definition — across every file of your machine.*
**Alt text:** `Peek-definition popup showing an INI key reached from a HAL [SECTION]KEY reference.`

## 5. `completion.png` — optional

**Scene:** in `tabletop.hal`, start a new line `setp pid.0.` and let the completion
list of `pid` pins/params appear (`Pgain`, `Igain`, `Dgain`, `command`, …), or type
`loadrt ` for component completion.
**Caption:** *Context-aware autocomplete: components, pins, signals, INI keys — even Mesa hostmot2 `config=` attributes.*
**Alt text:** `Autocomplete dropdown listing HAL component pins.`

## 6. `quickfix.png` — optional

**Scene:** `tabletop.hal`, cursor on `[JOINT_0]IGAIN`, open the Code Action
lightbulb (Cmd/Ctrl+.) showing the "add missing INI key" quick-fix.
**Caption:** *Quick-fixes for common mistakes.*
**Alt text:** `Quick-fix lightbulb menu offering to add a missing INI key.`

---

## Placement in the README

`packages/client/README.md` references, in order: hero (top, under the tagline),
hover-docs and gcode-subroutines inside the Features section, and the optional
three lower down. Images are linked by absolute `raw.githubusercontent.com/...main`
URL so they render on both GitHub and the VS Code Marketplace once pushed to `main`.

> Until the three required PNGs exist on `main`, the image links 404. Capture them
> before the next `release-please` release, or temporarily comment the image lines.
