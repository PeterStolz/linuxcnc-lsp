# LinuxCNC for VS Code

**Smart editing and live error-checking for LinuxCNC `.hal`, `.ini`, and `.ngc`
(G-code) files.** Autocomplete, hover docs, go-to-definition, and validation that
catches config mistakes *as you type*, instead of as a cryptic failure when the
machine starts.

Works fully offline, with no LinuxCNC install required, on Windows, macOS, or
Linux. ([Why offline?](#privacy-and-offline))

![A HAL file with a red squiggle under an INI reference that is not defined, and a hover tooltip explaining the error.](https://raw.githubusercontent.com/PeterStolz/linuxcnc-lsp/main/packages/client/images/hero-diagnostics.png)

*Cross-file checks catch bad references as you type, before the machine refuses to start.*

## Quick start

1. **Install** this extension.
2. **Open the folder** that holds your machine config, meaning the `.ini` and its
   `.hal` files together (File → Open Folder). Cross-file checks need the whole
   config, not a single open file.
3. **Edit.** Mistakes appear as red/yellow squiggles; hover anything for docs;
   Ctrl/Cmd-click a signal, pin, or `[SECTION]KEY` to jump to its definition.

There's nothing to configure for a single-machine workspace. (Got one `.hal`
shared by several machines? See [Multiple machines](#multiple-machines-in-one-workspace).)

## Features

### HAL (`.hal`)

- **Validation as you type:** unknown components, `setp` on a **read-only (output)
  pin**, type conflicts (e.g. a `bit` pin linked to a `float` signal), and signals
  with **no writer, no reader, or two writers** fighting over one signal.
- **`[SECTION]KEY` cross-checks:** a HAL reference to an INI constant is verified
  against the actual INI, and flagged (with a quick-fix) when the key is missing.
- **Navigate:** go-to-definition, find-references, rename, and document outline for
  signals, named component instances, and INI references, across every HAL file of
  the machine.
- **Autocomplete:** halcmd commands, `loadrt` component names and module
  parameters, `addf` functions/threads, signal names, and component pins (incl.
  `joint.N.*` / `axis.x.*` motion pins and **Mesa hostmot2 `config=`** attributes).
- **Quick-fixes** for common mistakes (e.g. "add the missing INI key").

### INI (`.ini`)

- Syntax + semantic highlighting, duplicate/conflicting-key detection, and value
  checks (warns when a value doesn't match its documented **type** or **enum**).
- Hover any key for docs; homing keys link straight to the LinuxCNC manual.
- Hover an INI key to see whether any HAL file references it.

![Editor hover tooltip showing LinuxCNC documentation for an INI key.](https://raw.githubusercontent.com/PeterStolz/linuxcnc-lsp/main/packages/client/images/hover-docs.png)

*Hover any component, pin, INI key, or G/M-code for docs pulled straight from the LinuxCNC source.*

> `.ini` files are recognized **by content**, not just by extension, so the
> extension never touches your unrelated `.ini` files. See
> [Privacy and offline](#privacy-and-offline).

### G-code (`.ngc`, `.nc`, `.gcode`, `.tap`)

- Hover docs for ~229 G/M/F/S/T words and parameter explanations (numbered, named,
  and global `#<_…>` params); completion of G/M codes and O-word keywords.
- **O-word subroutines:** go-to-definition and find-references, including
  **cross-file** `.ngc` subroutines resolved via the INI subroutine search path
  (`[RS274NGC]SUBROUTINES`, `[DISPLAY]PROGRAM_PREFIX`).
- Document outline and folding for subroutine / control-flow blocks.
- A **formatter** that indents `sub`/`if`/`while`/`do`/`repeat` blocks by nesting
  depth (Format Document). It only rewrites **leading indentation** — your
  trailing spaces and blank lines are left exactly as they are, so formatting an
  already-indented file changes nothing and never dirties your git history. Want
  trailing whitespace cleaned up too? Turn on VS Code's standard
  [`files.trimTrailingWhitespace`](https://code.visualstudio.com/docs/editor/codebasics#_trimming-trailing-whitespace)
  (globally, or just for G-code under `"[gcode]"`).
- Structural diagnostics: unmatched / unclosed / mismatched O-words, duplicate or
  nested subroutines, and misplaced `return`/`break`/`continue`.

![A G-code subroutine file showing O-word sub / if / endif structure with a hover tooltip documenting the G38.2 probe word.](https://raw.githubusercontent.com/PeterStolz/linuxcnc-lsp/main/packages/client/images/gcode-subroutines.png)

*O-word subroutines with full control-flow structure, plus hover docs for every G/M-code, with go-to-definition, folding, formatting, and structural checks on top.*

The G-code dialect is **LinuxCNC RS274NGC**. The hover docs and the O-word checks
assume that dialect; if you mainly write Grbl, Fanuc, or Marlin G-code, a generic
G-code extension may fit better (the highlighting still works, but the
LinuxCNC-specific O-word diagnostics won't apply to those dialects).

## Is this for you?

| You… | This extension |
|------|----------------|
| edit LinuxCNC `.hal` / `.ini` by hand | ✅ its core purpose: validation, hover, navigation |
| write LinuxCNC `.ngc` subroutines | ✅ outline, cross-file nav, formatter, structural checks |
| run Mesa hostmot2 or many machine configs | ✅ `config=` completion, custom `.comp`, [active-machine pinning](#multiple-machines-in-one-workspace) |
| want a 3D toolpath backplot or preview | ❌ not provided; use Axis, CAMotics, or your CAM |
| write Grbl / Fanuc / Marlin G-code | ⚠️ highlighting works; LinuxCNC-specific checks won't apply |

## Settings

| Setting | What it does |
|---------|--------------|
| `linuxcnc.iniDetection` | How `.ini` files are recognized as LinuxCNC configs: `auto` (by content, default), `extension` (every `.ini`), or `off`. |
| `linuxcnc.activeMachine` | Pin which machine provides context for a `.hal` shared by several INIs. See [below](#multiple-machines-in-one-workspace). |
| `linuxcnc.libDir` | Path to the system HAL library so `LIB:` HALFILE references resolve. Leave empty if LinuxCNC isn't installed locally. |
| `linuxcnc.metadata.path` | Use a metadata DB you regenerated from a specific LinuxCNC version (default: the bundled DB). |
| `linuxcnc.diagnostics.enable` | Turn all diagnostics on/off. |
| `linuxcnc.diagnostics.rules` | Per-rule severity overrides, e.g. `{ "hal.signal.noReader": "off" }`. See [Diagnostics reference](#diagnostics-reference). |
| `linuxcnc.trace.server` | Trace the client↔server protocol (`off`/`messages`/`verbose`) for bug reports. |

## Limitations

This is **static analysis**: it reads your files, it does not run LinuxCNC. So:

- **It can't see runtime-loaded code.** Pins/signals created by **Tcl or userspace
  components** are invisible to the model, which can produce advisory "signal has no
  writer" hints. When a workspace contains Tcl/`LIB:` files, the signal-graph checks
  are deliberately relaxed to avoid false errors. Set `linuxcnc.libDir` to resolve
  `LIB:` HALFILE references.
- **Metadata is pinned to one LinuxCNC version** (currently **2.10.0~pre1**; see
  `metadata-source.json`). Components/pins/docs reflect that version. On a very
  different version, regenerate the DB and point `linuxcnc.metadata.path` at it.
- **No 3D backplot or toolpath preview** and **no machine-limit checks** (such as
  feed rate vs. axis max velocity). Use Axis/CAMotics for visualization.
- **G-code is LinuxCNC RS274NGC only** (see the G-code note above).
- **G-code expressions aren't evaluated.** `#10 = [#1 + #2]` is parsed for
  structure, not checked for undefined parameters or math errors.
- **A `.hal` shared by multiple machines** uses the first machine found unless you
  pin one (see the next section).

Found a false positive or a miss? Please
[open an issue](https://github.com/PeterStolz/linuxcnc-lsp/issues) with the snippet;
that's exactly what improves it.

## Privacy and offline

- **No LinuxCNC required, any OS.** All component/pin/INI/G-code knowledge is
  extracted at build time from a pinned LinuxCNC source tree into a bundled
  database, so everything works with no LinuxCNC, no `halcmd`, and no network.
- **No telemetry, no network calls.** The extension collects nothing and phones
  nowhere; documentation is bundled. (Some hovers include a link to the online
  LinuxCNC manual, which only opens in your browser if *you* click it.)
- **It won't hijack your `.ini` files.** A `.ini` is treated as a LinuxCNC machine
  config only when its content has machine sections (`[EMC]`, `[HAL]`, `[KINS]`, …);
  set `linuxcnc.iniDetection` to `extension` or `off` to change that.
- **Open source**, GPL-2.0-or-later, on
  [GitHub](https://github.com/PeterStolz/linuxcnc-lsp); also on Open VSX.

## Troubleshooting

- **My `.ini` has no highlighting or checks.** It's recognized by content; if it
  lacks machine sections (or they're past the first ~20 KB), it stays plain text.
  Set `linuxcnc.iniDetection` to `extension`, or pick **LinuxCNC INI** from the
  language menu (bottom-right of the status bar).
- **A `[SECTION]KEY` is flagged "missing" but it exists.** The `.hal` is probably
  shared by several machines and the wrong one was picked. See
  [Multiple machines](#multiple-machines-in-one-workspace).
- **"Unknown component" for something real.** It may be newer than the bundled
  2.10.0~pre1 DB, or a custom `.comp`/Tcl component. Workspace `.comp` files are
  picked up automatically; otherwise regenerate the DB and set
  `linuxcnc.metadata.path`, or silence the rule (below).
- **Too noisy?** Lower or disable a rule via `linuxcnc.diagnostics.rules`, or add a
  comment `# linuxcnc-lsp-disable-line <ruleId>` (also `-next-line`, or a file-wide
  `# linuxcnc-lsp-disable <ruleId>`).

## Diagnostics reference

Every check has a stable rule id you can re-target with
`linuxcnc.diagnostics.rules` (values: `error`, `warning`, `information`, `hint`,
`off`), e.g. `{ "hal.signal.noReader": "off", "gcode.call.unknownSub": "warning" }`.

- **HAL:** `hal.syntax.*`, `hal.comp.unknownComponent`,
  `hal.param.readonlyParamSet`, `hal.signal.multipleWriters`,
  `hal.signal.noWriter`, `hal.signal.noReader`, `hal.signal.typeConflict`,
  `hal.iniref.sectionMissing`, `hal.iniref.keyMissing`
- **INI:** `ini.syntax.*`, `ini.key.unreferenced`, `ini.value.typeMismatch`,
  `ini.value.enumMismatch`
- **G-code:** `gcode.oword.unmatchedClose`, `gcode.oword.unclosed`,
  `gcode.oword.labelMismatch`, `gcode.oword.nestedSub`, `gcode.oword.duplicateSub`,
  `gcode.oword.duplicateElse`, `gcode.oword.returnOutsideSub`,
  `gcode.oword.controlOutsideLoop`, `gcode.oword.missingKeyword`,
  `gcode.call.unknownSub`

## Multiple machines in one workspace

Cross-file features (the `[SECTION]KEY` check, hover, go-to-definition, completion)
need to know which **machine** a `.hal` file belongs to. A machine is one `.ini`
plus all the `.hal` files it pulls in via `[HAL]HALFILE`. Usually that mapping is
unambiguous: one `.ini`, its own `.hal` files, and you can skip this section.

It gets ambiguous when **the same `.hal` is pulled in by two or more `.ini` files**,
which is very common in the LinuxCNC sample configs. In `configs/sim/axis`, for
instance, `core_sim.hal` is shared by `axis.ini`, `axis_mm.ini` (metric) and
`historical_lathe.ini`. Open `core_sim.hal` and the extension has three candidate
machines; with no pin it just uses the **first one it finds**.

### How you'll notice

There's no popup; the symptom is *wrong cross-file results in a shared `.hal`*:

- a `[SECTION]KEY` reference flagged as **missing** even though it exists, because
  the value lives in the *other* machine's INI, not the one that was picked;
- hover or go-to-definition on an INI reference jumping to the wrong machine's value
  (e.g. inch vs. mm).

If a shared `.hal` looks wrong, that's the cue to pin the machine you actually mean.

### Pinning the active machine

Run **LinuxCNC: Select Active Machine** from the Command Palette
(`Ctrl/Cmd+Shift+P`):

1. it scans the workspace for machine `.ini` files and lists them;
2. pick the one whose context you want (or **None** to clear the pin);
3. it writes `linuxcnc.activeMachine` to your workspace `.vscode/settings.json`.

The server re-resolves immediately, with no reload needed. You can also write the
setting by hand:

```jsonc
// flexicam/.vscode/settings.json
{
  // The folder holds Flexicam.ini and Flexicam_qtdragon.ini, which share the
  // same .hal files. Pin the qtdragon variant as the active machine.
  "linuxcnc.activeMachine": "Flexicam_qtdragon.ini"
}
```

The value is matched by path suffix, so use the shortest form that's unambiguous
in your workspace:

- a bare file name, `"Flexicam_qtdragon.ini"`
- a workspace-relative path, `"configs/sim/Flexicam.ini"`
- an absolute path, `"/home/cnc/linuxcnc/configs/flexicam/Flexicam.ini"`

Leave it empty (`""`) to go back to "first machine found".

### What the pin does (and doesn't) do

- It's **one pin per workspace**, not per file. Whenever a `.hal` is shared, the
  pinned machine wins, *as long as that machine actually pulls in this `.hal`*. If
  the pinned machine doesn't own a given shared file, that file falls back to its
  first owner, so the pin never makes things worse.
- `.hal` files owned by exactly one machine are unaffected; pinning only matters
  for shared files.
- Working across machine families that don't share files? Re-run the command to
  switch the pin as you move between them.

> Heads-up: don't use a `${workspaceFolder}/…` value here. VS Code only expands
> `${workspaceFolder}` for a few built-in settings, not third-party ones, so it
> would be passed through literally and match nothing. Use a plain relative path.

## Credits

This is an unofficial, community extension and is not affiliated with or endorsed
by the LinuxCNC project. The icon is based on the LinuxCNC application icon
([linuxcnc/linuxcnc](https://github.com/linuxcnc/linuxcnc), GPL-2.0), with an
added "LSP" badge.
