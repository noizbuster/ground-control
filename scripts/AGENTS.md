<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# scripts

## Purpose

Build, dev, and QA tooling for gctrl. Production build is esbuild bundles plus a post-copy of non-TS FFI hooks. Dev watches and relaunches the app. Separate scripts drive Mission Control cross-repo e2e and offline refresh/render evidence harnesses.

## Key Files

| File | Description |
|------|-------------|
| `build.mjs` | esbuild ESM bundle: `src/index.ts` → `dist/index.js`, `refresh-worker` → `dist/db/`; packages external; supports `--watch` |
| `copy-hooks.mjs` | Copies `ffi-koffi-adapter.cjs`, `ffi-esm-hooks.mjs`, `ffi-register.mjs` from `src/lib` → `dist/lib` after build |
| `dev.mjs` | Dev loop: esbuild watch + app relaunch on `dist` mtime; bypasses `bin/gctrl.js`; restores alt-screen on teardown |
| `run-mc-child-abort-e2e.mjs` | Sole supported MC e2e entry: absolute `--mc-worktree` / `--gc-worktree`, validates CLI/sidecar/fixture, injects env, runs vitest on the e2e file with `shell: false` |
| `create-refresh-qa-db.ts` | Seeds deterministic OpenCode QA sqlite (evidence path under `.sisyphus/`) with hierarchy sessions |
| `run-refresh-qa.ts` | Tmux/script TUI refresh harness against fixture DB; hierarchy assertions |
| `verify-render-guard.ts` | Spawns app briefly against QA fixture; captures render-count stats for guard evidence |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- `pnpm build` = `build.mjs` && `copy-hooks.mjs`. If you add new non-TS runtime assets under `src/lib`, update `copy-hooks.mjs`.
- Keep esbuild externals aligned with runtime `node_modules` packages (`@opentui/core`, `koffi`, etc.).
- `dev.mjs` does not go through `bin/gctrl.js`; bin remains the published/signal-safe launcher.
- MC e2e runner must remain shell-free spawn; contract tests lock this.
- Refresh QA scripts write under gitignored evidence dirs — not CI gates.

### Testing Requirements
- Typecheck TS scripts: `pnpm typecheck:scripts`.
- After build changes, smoke: `pnpm build && pnpm start` (or `pnpm dev`).
- MC e2e: see `test/AGENTS.md` and `docs/mc-child-abort-release.md`.

### Common Patterns
- Node ESM `.mjs` for toolchain; `.ts` run via `tsx` for QA.
- Evidence-oriented scripts prefer deterministic fixtures over live user DBs.

## Dependencies

### Internal
- Build inputs: `src/index.ts`, `src/db/refresh-worker.ts`, `src/lib/ffi-*.{mjs,cjs}`
- E2E runner → `test/missionControlChildAbort.e2e.test.ts` + external MC worktree
- QA may use `src/lib/which` and OpenCode path helpers

### External
- `esbuild`, `tsx`, Node `child_process`/`fs`, pnpm/vitest for e2e invocation

<!-- MANUAL: -->
