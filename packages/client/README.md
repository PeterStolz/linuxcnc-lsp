# LinuxCNC for VSCode

Language support for **LinuxCNC** configuration files: `.hal` (HAL), `.ini`
(machine config), and `.ngc` (G-code).

## Features

- Syntax highlighting + semantic highlighting for HAL / INI / G-code
- Validation: HAL/INI syntax errors, and an **error when a HAL file references
  an INI constant `[SECTION]KEY` that is not defined** in the machine INI
- Multiple-writer detection on HAL signals
- Go-to-definition / find-references / highlight for HAL signals, INI variables
  and component pins — across all HAL files of a machine
- Hover docs for halcmd commands, component pins/params/functions, and INI keys,
  sourced from the LinuxCNC source
- Hovering a homing INI variable renders that section of the LinuxCNC docs
- Context-aware autocomplete: halcmd commands, `loadrt` component names and
  module parameters (incl. Mesa `config=`), `addf` functions/threads, signal
  names, component pins (incl. `joint.N.*`/`axis.x.*` motion pins), and
  `[SECTION]KEY` INI references — plus section/key completion inside the INI
- Custom workspace `.comp` components are parsed and contribute hover
- INI value checks: warns when a value doesn't match its documented type (e.g. a
  non-number for a `real`/`int` key) or falls outside an `enum`'s allowed values
- G-code (`.ngc`): hover docs for G/M/F/S/T words (from the LinuxCNC docs),
  explanations for axis words, numbered/named parameters and O-word control flow,
  plus completion of G/M codes and O-word keywords
- G-code O-word subroutines: go-to-definition / find-references (including
  cross-file `.ngc` files resolved via the INI subroutine search path —
  `[RS274NGC]SUBROUTINES`, `[DISPLAY]PROGRAM_PREFIX`), a document outline and
  folding for subroutine / control-flow blocks, a formatter that indents
  `sub`/`if`/`while`/`do`/`repeat` blocks by nesting depth, and structural
  diagnostics (unmatched / unclosed / mismatched O-words, duplicate or nested
  subroutines, misplaced `return`/`break`/`continue`)

Open a folder containing your machine config (`.ini` + `.hal` files) for the
cross-file features to work.

## Multiple machines in one workspace

Cross-file features (the `[SECTION]KEY` check, hover, go-to-definition, completion)
need to know which **machine** a `.hal` file belongs to — a machine is one `.ini`
plus all the `.hal` files it pulls in via `[HAL]HALFILE`. Usually that mapping is
unambiguous: one `.ini`, its own `.hal` files.

It gets ambiguous when **the same `.hal` is pulled in by two or more `.ini` files**
— very common in the LinuxCNC sample configs. In `configs/sim/axis`, for instance,
`core_sim.hal` is shared by `axis.ini`, `axis_mm.ini` (metric) and
`historical_lathe.ini`. Open `core_sim.hal` and the extension has three candidate
machines; with no pin it just uses the **first one it finds**.

### How you'll notice

There's no popup — the symptom is *wrong cross-file results in a shared `.hal`*:

- a `[SECTION]KEY` reference flagged as **missing** even though it exists — because
  the value lives in the *other* machine's INI, not the one that was picked;
- hover / go-to-definition on an INI reference jumping to the wrong machine's value
  (e.g. inch vs. mm).

If a shared `.hal` looks wrong, that's the cue to pin the machine you actually mean.

### Pinning the active machine

Run **LinuxCNC: Select Active Machine** from the Command Palette
(`Ctrl/Cmd+Shift+P`):

1. it scans the workspace for machine `.ini` files and lists them;
2. pick the one whose context you want (or **None** to clear the pin);
3. it writes `linuxcnc.activeMachine` to your workspace `.vscode/settings.json`.

The server re-resolves immediately — no reload needed. You can also write the
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

- a bare file name — `"Flexicam_qtdragon.ini"`
- a workspace-relative path — `"configs/sim/Flexicam.ini"`
- an absolute path — `"/home/cnc/linuxcnc/configs/flexicam/Flexicam.ini"`

Leave it empty (`""`) to go back to "first machine found".

### What the pin does (and doesn't) do

- It's **one pin per workspace**, not per file. Whenever a `.hal` is shared, the
  pinned machine wins — *as long as that machine actually pulls in this `.hal`*. If
  the pinned machine doesn't own a given shared file, that file falls back to its
  first owner, so the pin never makes things worse.
- `.hal` files owned by exactly one machine are unaffected — pinning only matters
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
