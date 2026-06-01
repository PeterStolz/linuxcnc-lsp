# Changelog

## [0.1.7](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.6...v0.1.7) (2026-06-01)


### Features

* **gcode:** formatter preserves trailing/blank whitespace by default (closes [#11](https://github.com/PeterStolz/linuxcnc-lsp/issues/11)) ([#17](https://github.com/PeterStolz/linuxcnc-lsp/issues/17)) ([c5c033c](https://github.com/PeterStolz/linuxcnc-lsp/commit/c5c033c081ac2ae3e25c14ac122a898ca15e7c02))

## [0.1.6](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.5...v0.1.6) (2026-06-01)


### Miscellaneous Chores

* release 0.1.6 (refresh marketplace listing) ([#13](https://github.com/PeterStolz/linuxcnc-lsp/issues/13)) ([d944286](https://github.com/PeterStolz/linuxcnc-lsp/commit/d944286ef7243f85ac454ec6da0b3511e5fc75d2))

## [0.1.5](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.4...v0.1.5) (2026-05-31)


### Features

* **gcode:** O-word subroutine navigation, formatter, and diagnostics ([#8](https://github.com/PeterStolz/linuxcnc-lsp/issues/8)) ([6493fd1](https://github.com/PeterStolz/linuxcnc-lsp/commit/6493fd1295934cec87d44da14f388782e1fa3c0b))

## [0.1.4](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.3...v0.1.4) (2026-05-31)


### Bug Fixes

* **client:** clarify activeMachine setting and document multi-machine workflow ([#6](https://github.com/PeterStolz/linuxcnc-lsp/issues/6)) ([083a02d](https://github.com/PeterStolz/linuxcnc-lsp/commit/083a02d611a2528861de9ef4a768c75a9325c5dc))

## [0.1.3](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.2...v0.1.3) (2026-05-31)


### Bug Fixes

* 8 round-3 fuzz bugs (edges-of-edges; loop converging) ([#4](https://github.com/PeterStolz/linuxcnc-lsp/issues/4)) ([25fa5a9](https://github.com/PeterStolz/linuxcnc-lsp/commit/25fa5a96785b6a46352182c44d4b1801f5c9a1dd))

## [0.1.2](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.1...v0.1.2) (2026-05-31)


### Features

* **client:** add extension icon (LinuxCNC logo + LSP badge) ([7fe0c3d](https://github.com/PeterStolz/linuxcnc-lsp/commit/7fe0c3d1bc5e3abc41ed3d2e2e0637f96347885f))


### Bug Fixes

* 13 round-2 fuzz bugs (mostly adjacent edges of the round-1 fixes) ([c8378e4](https://github.com/PeterStolz/linuxcnc-lsp/commit/c8378e47ad32f2f7d8d575641686868b581dfe1a))
* 8 accuracy bugs from the full machine audit (247 configs) ([ef124d7](https://github.com/PeterStolz/linuxcnc-lsp/commit/ef124d7a69e2f114dad6e1ca2a4501ed4d5dc519))
* **release:** point Marketplace publish at VSCD_PAT secret; add manual re-publish dispatch ([eaf91a6](https://github.com/PeterStolz/linuxcnc-lsp/commit/eaf91a6b1991d778ff89efff0c8c46dbdb0d4d63))

## [0.1.1](https://github.com/PeterStolz/linuxcnc-lsp/compare/v0.1.0...v0.1.1) (2026-05-31)


### Features

* G-code intellisense (word docs, parameters, O-words) ([dd366f6](https://github.com/PeterStolz/linuxcnc-lsp/commit/dd366f6360fdf62b6006769446ed7055c0575637))
* INI value type + enum validation ([df2a23a](https://github.com/PeterStolz/linuxcnc-lsp/commit/df2a23a9aa1d28b495a4bd6a3c9c8aae6e3b30cc))
* pin the active machine for HAL files shared by two configs ([9a744e6](https://github.com/PeterStolz/linuxcnc-lsp/commit/9a744e6b704086873510c12bb1ba473b71faee55))


### Bug Fixes

* **build:** resolve @linuxcnc/* from source in esbuild and vitest ([78478bf](https://github.com/PeterStolz/linuxcnc-lsp/commit/78478bf08cd1cb033d615e7dc56b0585777076ef))
* INI-side find-references/highlight, adoc formatting, INI key hover ([eb0428b](https://github.com/PeterStolz/linuxcnc-lsp/commit/eb0428b556753d503e751e670be12c030df8c233))
* **release:** stop managing extension package.json; drop stale npm lockfile ([74cbe26](https://github.com/PeterStolz/linuxcnc-lsp/commit/74cbe26c9c59313293618fed45bca138197153bc))
* resolve 22 distinct bugs from the multi-agent fuzz/persona sweep ([501617f](https://github.com/PeterStolz/linuxcnc-lsp/commit/501617ff8dc6330ebcbc7befa516a2c8ef0d99a5))
