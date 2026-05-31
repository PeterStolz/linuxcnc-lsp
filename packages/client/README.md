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
- Custom workspace `.comp` components are parsed and contribute hover

Open a folder containing your machine config (`.ini` + `.hal` files) for the
cross-file features to work.
