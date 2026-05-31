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

Open a folder containing your machine config (`.ini` + `.hal` files) for the
cross-file features to work.
