# LinuxCNC LSP & VSCode extension

Language Server Protocol implementation and VSCode extension for editing
**LinuxCNC** machine configurations: `.hal` (Hardware Abstraction Layer),
`.ini` (machine config) and `.ngc` (G-code) files.

## Features

- Syntax highlighting (TextMate grammars) + semantic highlighting
- Parsing & validation of HAL and INI with precise diagnostics
- Go-to-definition / find-references / rename for HAL signals, named component
  instances and INI keys
- Error when a HAL file references an INI constant `[SECTION]KEY` that is not
  present in the owning INI
- Hover documentation for halcmd commands, component pins/params/functions,
  INI keys and G/M-codes — sourced from the LinuxCNC source tree
- Hover over a homing INI variable renders that section of the LinuxCNC docs
- Hover over an INI key tells you whether it is referenced by any HAL file
- Context-aware autocomplete, including Mesa hostmot2 card pins and `config=`
  string attributes
- Custom workspace `.comp` components are parsed and contribute hover/completion

## Architecture

Pure static analysis: there is **no** dependency on a running LinuxCNC /
`halcmd` (development happens on machines where LinuxCNC cannot run). Component,
pin, INI and G-code metadata is extracted at build time from a pinned LinuxCNC
source checkout (see `metadata-source.json`) into a bundled JSON database.

Monorepo (npm workspaces):

| Package | Purpose |
|---|---|
| `@linuxcnc/core` | tokenizer, parsers, AST, machine model, diagnostics, provider logic — **no vscode/LSP deps**, fully unit-tested |
| `@linuxcnc/metadata` | build-time extractors, bundled DB, runtime loader + workspace overlay, asciidoc→markdown |
| `@linuxcnc/server` | `vscode-languageserver` wiring over `core` |
| `client` | the VSCode extension; spawns the server, contributes grammars/config |

## Development

This repo uses **pnpm** (v10+; pinned via `packageManager`). With a recent Node,
`corepack enable` makes the right pnpm available automatically.

```sh
pnpm install
pnpm run typecheck   # tsc -b project references
pnpm test            # vitest unit + golden-corpus tests
pnpm run lint
pnpm run gen:db      # regenerate the metadata DB from the pinned LinuxCNC checkout
pnpm run package     # build the .vsix
```

See `../linuxcnc/.claude` plan or `docs/` for the full feature spec.

## License

Licensed under the **GNU General Public License v2.0 or later** (GPL-2.0-or-later);
see [`LICENSE`](./LICENSE).

This project bundles a metadata database (`packages/metadata/data/`) extracted
from the **LinuxCNC** source tree and documentation (see `metadata-source.json`),
which is itself licensed under the GNU GPL. Component, pin, INI and G-code
descriptions are derived from LinuxCNC's man pages, `.comp` files and docs —
© the LinuxCNC project and contributors. The GPL is used here to stay fully
compatible with that upstream material.
