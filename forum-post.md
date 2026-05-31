# Forum post — LinuxCNC "Show your Stuff"

**Subject:** LinuxCNC LSP — smart editing + live error-checking for HAL, INI and G-code (VS Code / any LSP editor)

---

**TL;DR:** I built a free, open-source (GPL) language server that gives you autocomplete, hover docs, go-to-definition and *live error checking* for your `.hal`, `.ini` and `.ngc` files — so config mistakes show up as red squiggles in your editor instead of as a cryptic failure when you start LinuxCNC.

Marketplace: https://marketplace.visualstudio.com/items?itemName=PeterStolz.linuxcnc-lsp

---

We all know the drill: you tweak a HAL file, start the machine, and it dies — a `[SECTION]KEY` that doesn't resolve to anything in your INI, a `setp` on a pin that's actually read-only, or a signal that silently does nothing because nothing writes to it (or two things fight to write it). This catches that stuff *while you type.*

**What it catches for you (HAL):**
- **Unknown components** (it knows 214 HAL components, 2,153 pins, 589 parameters — which also power autocomplete and the read-only/direction checks below)
- **Signals with no writer, no reader, or two writers** fighting over one signal
- **Type conflicts** — linking a `bit` pin to a `float` signal
- **`setp` on a read-only (output) pin**
- **`[SECTION]KEY` references that don't resolve** against the machine's INI
- It actually understands `count=`, `names=`, and array modparams like `num_chan=`, so multi-channel components resolve correctly — and it matches halcompile's prefix rules (e.g. `loadrt hal_parport` → `parport.0.*`)

**For INI files:**
- Unknown keys, duplicate/conflicting keys, values that don't match the expected type or enum
- Hover any key for docs; homing keys link straight to the LinuxCNC manual
- Cross-file aware: HAL files that reference `[SECTION]KEY` get checked against the actual INI

**For G-code (.ngc/.nc/.tap):**
- Hover docs for ~229 G/M-words, autocomplete for codes and parameters
- O-word subroutines: go-to-definition / find-references (incl. cross-file `.ngc` resolved via the INI subroutine search path), document outline, folding, a block-indenting formatter, and structural checks (unmatched/unclosed/mismatched O-words)

Plus the usual editor niceties everywhere: autocomplete, go-to-definition, find-all-references, rename-across-files, document outline, and quick-fixes (e.g. "add the missing INI key").

**A couple of things I think this community will appreciate:**
- It's **pure static analysis** — no running LinuxCNC instance, no special setup. Just open your config folder.
- I validated it against **all 247 stock LinuxCNC configs**. That audit even turned up a handful of real conflicting-key bugs in the shipped configs.
- It's a standard **LSP**, so while the easy path is the VS Code extension, it'll plug into Neovim/Emacs/etc. too.
- **GPL-2.0**, source on GitHub: https://github.com/PeterStolz/linuxcnc-lsp — issues and PRs very welcome.

It's early (v0.1.x), so if it flags something it shouldn't, or misses something it should, please tell me — bug reports against your real configs are exactly what makes it better.
