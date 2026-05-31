# Marketplace images

These images are referenced by `../README.md` (the marketplace listing) via
absolute `raw.githubusercontent.com/.../main/packages/client/images/...` URLs.

Capture them with the reproducible demo config and the per-shot recipe in
[`docs/SCREENSHOTS.md`](../../../docs/SCREENSHOTS.md).

Captured (the README links these):

| File | Shot |
|------|------|
| `hero-diagnostics.png` | live error-checking on a HAL file (the hero image) — the `[JOINT_0]IGAIN` missing-INI-key squiggle + hover |
| `hover-docs.png` | hover documentation from the LinuxCNC source (an INI `[TRAJ]COORDINATES` key) |
| `gcode-subroutines.png` | a G-code O-word subroutine (`o<probe>` sub/if/endif) with a `G38.2` hover doc |

Optional, not yet captured (would enrich the listing; see `docs/SCREENSHOTS.md`):
`goto-definition.png`, `completion.png`, `quickfix.png`, and an Outline + cross-file
peek variant of `gcode-subroutines.png`.

PNG, ~1200px wide, tightly cropped. An optional `hero-diagnostics.gif` may replace
the hero PNG to show diagnostics appearing as you type.
