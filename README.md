# LinuxCNC LSP & VSCode extension

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=PeterStolz.linuxcnc-lsp"><img alt="VS Marketplace version" src="https://vsmarketplacebadges.dev/version-short/PeterStolz.linuxcnc-lsp.svg?label=VS%20Marketplace&color=0066b8&logo=visualstudiocode"></a>
  <a href="https://open-vsx.org/extension/PeterStolz/linuxcnc-lsp"><img alt="Open VSX version" src="https://img.shields.io/open-vsx/v/PeterStolz/linuxcnc-lsp?label=Open%20VSX&logo=eclipseide&color=c160ef"></a>
  <a href="https://github.com/PeterStolz/linuxcnc-lsp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/PeterStolz/linuxcnc-lsp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://codecov.io/gh/PeterStolz/linuxcnc-lsp"><img alt="Coverage" src="https://codecov.io/gh/PeterStolz/linuxcnc-lsp/branch/main/graph/badge.svg"></a>
  <a href="LICENSE"><img alt="License: GPL-2.0-or-later" src="https://img.shields.io/badge/license-GPL--2.0--or--later-blue.svg"></a>
</p>

Language Server Protocol implementation and VSCode extension for editing
**LinuxCNC** machine configurations: `.hal` (Hardware Abstraction Layer),
`.ini` (machine config) and `.ngc` (G-code) files.

## Install

- **VS Code / VSCodium:** search for **“LinuxCNC: HAL, INI & G-code”** in the
  Extensions view, or install from the
  [**Visual Studio Marketplace**](https://marketplace.visualstudio.com/items?itemName=PeterStolz.linuxcnc-lsp)
  or [**Open VSX**](https://open-vsx.org/extension/PeterStolz/linuxcnc-lsp).
- Then **open the folder** with your machine config (the `.ini` and its `.hal`
  files) and start editing. The
  [user guide](packages/client/README.md#quick-start) covers what you'll see.

Works fully offline, with no LinuxCNC install required, on Windows, macOS, or Linux.

## Features

- Syntax highlighting (TextMate grammars) + semantic highlighting
- Parsing & validation of HAL and INI with precise diagnostics
- Go-to-definition / find-references / rename for HAL signals, named component
  instances and INI keys
- Error when a HAL file references an INI constant `[SECTION]KEY` that is not
  present in the owning INI
- Hover documentation for halcmd commands, component pins/params/functions,
  INI keys and G/M-codes, sourced from the LinuxCNC source tree
- Hover over a homing INI variable renders that section of the LinuxCNC docs
- Hover over an INI key tells you whether it is referenced by any HAL file
- Context-aware autocomplete, including Mesa hostmot2 card pins and `config=`
  string attributes
- Custom workspace `.comp` components are parsed and contribute hover/completion
- G-code O-word subroutines: go-to-definition, find-references, and rename
  (including cross-file `.ngc` resolution via the INI subroutine search path,
  scoped per machine config), document outline, folding, a block-indenting
  formatter, and structural diagnostics for unmatched, unclosed, or mismatched
  O-words

> **Using it** (not hacking on it)? Install **LinuxCNC: HAL, INI & G-code** from
> the VS Code Marketplace or Open VSX, open the folder containing your `.ini` and
> `.hal` files, and edit. The user-facing guide (quick start, settings,
> troubleshooting, diagnostics reference) lives in
> [`packages/client/README.md`](packages/client/README.md).

## Limitations

Static analysis has edges worth knowing:

- **Runtime-loaded code is invisible.** Pins/signals created by Tcl or userspace
  components aren't modeled, so signal-graph checks (no-writer/no-reader) are
  advisory and are relaxed when a workspace contains Tcl/`LIB:` files. Set
  `linuxcnc.libDir` to resolve `LIB:` HALFILE references.
- **Metadata is pinned** to one LinuxCNC version (see `metadata-source.json`);
  regenerate (`pnpm run gen:db`) and point `linuxcnc.metadata.path` at it for a
  very different version.
- **No 3D backplot or toolpath preview** and **no machine-limit checks**.
- **G-code is LinuxCNC RS274NGC only**; expressions are parsed for structure, not
  evaluated.
- A `.hal` **shared by multiple machines** uses the first one found unless pinned
  via `linuxcnc.activeMachine`.

## Privacy

Fully offline: **no telemetry, no network calls, no LinuxCNC install required.**
All documentation/metadata is bundled at build time; the only `linuxcnc.org`
references in the source are build-time doc-extraction string handling, never
runtime requests. `.ini` files are recognized by content so unrelated `.ini`
files are never touched.

## Architecture

Pure static analysis: there is **no** dependency on a running LinuxCNC /
`halcmd` (development happens on machines where LinuxCNC cannot run). Component,
pin, INI and G-code metadata is extracted at build time from a pinned LinuxCNC
source checkout (see `metadata-source.json`) into a bundled JSON database.

Monorepo (npm workspaces):

| Package | Purpose |
|---|---|
| `@linuxcnc/core` | tokenizer, parsers, AST, machine model, diagnostics, provider logic (**no vscode/LSP deps**, fully unit-tested) |
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
descriptions are derived from LinuxCNC's man pages, `.comp` files and docs,
© the LinuxCNC project and contributors. The GPL is used here to stay fully
compatible with that upstream material.
