# Marketplace images

These images are referenced by `../README.md` (the marketplace listing) via
absolute `raw.githubusercontent.com/.../main/packages/client/images/...` URLs.

Capture them with the reproducible demo config and the per-shot recipe in
[`docs/SCREENSHOTS.md`](../../../docs/SCREENSHOTS.md).

Required before the next release (the README links these):

| File | Shot |
|------|------|
| `hero-diagnostics.png` | live error-checking on a HAL file (the hero image) |
| `hover-docs.png` | hover documentation from the LinuxCNC source |
| `gcode-subroutines.png` | G-code O-word outline + cross-file go-to-definition |

Optional (referenced lower in the README; safe to add later):
`goto-definition.png`, `completion.png`, `quickfix.png`.

PNG, ~1200px wide, tightly cropped. An optional `hero-diagnostics.gif` may replace
the hero PNG to show diagnostics appearing as you type.
