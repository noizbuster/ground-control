<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# bin

## Purpose

Published CLI entry for the `gctrl` package. Thin launcher over the built `dist/` tree — not application logic.

## Key Files

| File | Description |
|------|-------------|
| `gctrl.js` | Package `bin.gctrl` target. Spawns `node --import dist/lib/ffi-register.mjs --experimental-sqlite dist/index.js`; forwards SIGINT/TERM/HUP; forced SIGKILL after ~2s; restores primary screen on child exit |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Require a prior `pnpm build` so `dist/index.js` and `dist/lib/ffi-register.mjs` exist.
- Keep FFI register + `--experimental-sqlite` flags in sync with worker/`src` expectations.
- Screen restore here is belt-and-suspenders with `src/index.ts` shutdown — do not remove either side casually.
- Do not move app logic into this file; keep it a process supervisor.

### Testing Requirements
- Smoke: `pnpm build && node bin/gctrl.js` (or `pnpm start`) in a TTY.
- Non-TTY path should print a tab-separated snapshot and exit (behavior owned by app, launched here).

### Common Patterns
- Child stdio inherit; signal forwarding; exit-code propagation.

## Dependencies

### Internal
- `dist/index.js`, `dist/lib/ffi-register.mjs` (build outputs)

### External
- Node.js runtime only

<!-- MANUAL: -->
