<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# ground-control

## Purpose

`gctrl` (package name `gctrl`, repo `ground-control`) is a Node.js terminal TUI that monitors OpenCode, Codex, Claude Code, Pi, omp, Gajae Code, and Mission Control sessions in real time. It merges multi-source session snapshots on a 2s refresh cycle, renders a card grid + detail/hierarchy panes via `@opentui/core`, and supports source-native attach, delete, and child-stop flows. Published as the `gctrl` CLI (`bin/gctrl.js` → `dist/`).

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Package manifest: scripts, `bin.gctrl`, deps (`@opentui/core`, `koffi`), engines Node `>=22.13`, pnpm `11.17.0` |
| `pnpm-workspace.yaml` | Hoists `@opentui/core-*` platform packages; allows esbuild/koffi builds |
| `pnpm-lock.yaml` | Locked dependency graph |
| `tsconfig.json` | Strict TS for `src/**`; ES2022, ESM, bundler resolution, `noEmit` |
| `tsconfig.build.json` | Build-time TS config overlay |
| `vitest.config.ts` | Vitest node env; `globals: false` (import from `vitest`) |
| `.npmrc` | npm/pnpm client settings |
| `.gitignore` | Ignores `node_modules/`, `dist/`, agent dirs (`.omo`, `.omc`, `.sisyphus`, `.gctrl-captures`, `.claude`) |
| `README.md` | User-facing docs: keys, status detection, path overrides, stop/delete contracts |
| `LICENSE` | MIT |
| `banner.png` / `demo.png` / `demo2.png` | README assets |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Application source: entry, types, db adapters, lib, UI, config (see `src/AGENTS.md`) |
| `test/` | Flat Vitest unit/integration suite + gated MC e2e (see `test/AGENTS.md`) |
| `scripts/` | Build, dev loop, FFI hook copy, MC e2e runner, refresh QA (see `scripts/AGENTS.md`) |
| `bin/` | Published CLI launcher (see `bin/AGENTS.md`) |
| `bench/` | Observational OpenCode SQLite microbench (see `bench/AGENTS.md`) |
| `docs/` | Operator/release contracts (see `docs/AGENTS.md`) |
| `.github/` | GitHub Actions workflows (see `.github/AGENTS.md`) |

**Not documented (gitignored / non-product):** `.omo/`, `.omc/`, `.omx/`, `.sisyphus/`, `.gctrl-captures/`, `node_modules/`, `dist/`.

## For AI Agents

### Working In This Directory
- Package manager is **pnpm**. After manifest changes: `pnpm install`.
- Runtime requires **Node >= 22.13** (README recommends 24+ for built-in `node:sqlite`). CI uses Node 26.3 for MC e2e.
- Build: `pnpm build` → `scripts/build.mjs` (esbuild) + `scripts/copy-hooks.mjs` (FFI hooks into `dist/lib/`).
- Dev: `pnpm dev` (watch rebuild + relaunch; bypasses `bin/gctrl.js`).
- Start built app: `pnpm start` / `node bin/gctrl.js` (needs prior build).
- Lint scope is `src` only: `pnpm lint` (`biome check src`). Full gate: `pnpm check` (lint + typecheck).
- Do not commit agent/runtime dirs (`.omo`, `.omc`, `.sisyphus`, `.gctrl-captures`).
- Published files are only `bin` + `dist`; source lives in the repo, not the npm tarball layout beyond that.

### Testing Requirements
- Default: `pnpm test` (`vitest run`). E2E file self-skips without runner env.
- Typecheck: `pnpm typecheck` (src); `pnpm typecheck:scripts` for `scripts/**/*.ts`.
- Mission Control cross-repo e2e is **not** plain vitest — use `scripts/run-mc-child-abort-e2e.mjs` with absolute MC/GC worktrees (see `test/AGENTS.md`, `docs/mc-child-abort-release.md`).
- Prefer targeted `pnpm exec vitest run test/<file>.test.ts` while iterating.

### Common Patterns
- ESM throughout (`"type": "module"`).
- Domain types in `src/types.ts`; per-source adapters in `src/db/`; pure helpers in `src/lib/`; OpenTUI factories in `src/ui/`.
- Multi-source reads run in a **worker thread** (`src/db/refresh-worker.ts`); main thread owns UI + mutations.
- Path overrides use `GCTRL_*` env vars (and source-native vars like `MCTRL_DATA_DIR`, `PI_CODING_AGENT_DIR`). See README and `src/db/AGENTS.md`.
- Barrels (`src/*/index.ts`) are often empty — import concrete modules.

### Architecture Snapshot
```
bin/gctrl.js
  → node --import dist/lib/ffi-register.mjs --experimental-sqlite dist/index.js
src/index.ts (OpenTUI app, AppState, keys, attach/delete/stop)
  → Worker(src/db/refresh-worker) merges get*Snapshot from all sources
  → lib filter/sort/coordinator → ui factories → render
```

## Dependencies

### Internal
- N/A at repo root (this is the package root).

### External
- `@opentui/core` `0.4.5` — terminal UI renderer
- `koffi` — FFI backend shim for OpenTUI on Node (see `src/lib` FFI notes; pin vs Node 24 crash risk)
- Dev: TypeScript, Vitest 4, Biome, esbuild, tsx, `@types/node`
- Host CLIs (optional per source): `opencode`, `codex`, `claude`, `pi`, `omp`, `mc`/`mctrl`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
