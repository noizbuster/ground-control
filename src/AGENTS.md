<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# src

## Purpose

Entire gctrl application source. Entry is `index.ts` (`void main()`), launched via `bin/gctrl.js` → `dist/index.js` with `--experimental-sqlite` and the koffi FFI register import. `types.ts` holds the shared domain model. Subdirs split read adapters (`db/`), pure/domain helpers (`lib/`), OpenTUI views (`ui/`), and agent color chrome (`config/`).

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Monolithic TUI runtime (~large): `main()`, `AppState`, OpenTUI mount/render, refresh worker lifecycle, 2s poll + 10s attach-signal scan, keyboard/mouse, attach/delete/kill flows, alt-screen teardown |
| `types.ts` | Domain types only (no runtime): `SessionStatus`, `SessionSource`, `SessionCapabilities`, `Session`/`SubagentSession`/`SessionRecord`, MC metadata, hierarchy mode unions, thin UI state interfaces |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `db/` | Per-source snapshot readers, refresh worker, stop/delete control plane (see `db/AGENTS.md`) |
| `lib/` | Shared helpers: status, filter/sort, hierarchy, refresh coord, abort plans, FFI hooks (see `lib/AGENTS.md`) |
| `ui/` | OpenTUI view factories: grid, card, detail, hierarchy (see `ui/AGENTS.md`) |
| `config/` | Agent name/color map (see `config/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Prefer extending `db`/`lib`/`ui` over growing `index.ts` further; `index.ts` already owns orchestration.
- `SessionSource` + `SessionCapabilities` are the cross-module dispatch contract (`lib/sessionSource.ts`).
- **Refresh invariants (do not break):**
  1. Generation gating — ignore worker messages when `response.generation !== refreshGeneration` or worker instance ≠ current.
  2. Dispatch gate — only `postMessage` refresh when worker `status === "usable"` and `refreshDispatchGateOpen`.
  3. Coordinator coalesce — apply only if `shouldApplyResponse(requestId)`.
  4. Selection deferral — park refresh/render while text selection is in progress.
  5. Render signature skip — unchanged `createRefreshRenderSignature` must not force full re-render.
  6. Stable DOM IDs — `createStaticLayout` once; `render()` mutates existing nodes via `replaceChildren`.
  7. Selection stickiness — re-resolve `selectedIndex` by `selectedSessionId` after every snapshot.
  8. Pi/omp delete — reset worker caches before delete; reopen gate only after usable ack.
  9. Poll pause on mutate — delete/kill/attach stop polling; always restart in `finally`.
  10. Terminal teardown — write `RESTORE_PRIMARY_SCREEN_SEQUENCE` before `process.exit`.
  11. Worker URL — `new Worker(new URL("./db/refresh-worker", import.meta.url), { execArgv: ["--experimental-sqlite", ...] })` (URL object required).
  12. Protocol clone-safety — refresh payloads must be structured-clone-safe (no DB handles/Maps/Sets/functions).
  13. Partial source failure — worker succeeds if ≥1 source ok; all-fail clears sessions.
- Main thread does **not** import snapshot readers; only the worker does. Index imports mutation/stop APIs and protocol types.
- Capability gates: `canAbortSessionChildren` is false for claude/pi; true for opencode/codex/omp/mission-control.

### Testing Requirements
- No direct unit tests for `index.ts`. Cover behavior via `test/` on lib/db/ui modules.
- High-value contracts: `refreshCoordinator`, `refreshRenderSignature`, `sessionList`, `sessionSource`, `sessionStopShortcut`, `attachedSessionSignals`, `abortTargets`, plus per-source snapshot/delete/stop tests.
- Manual TUI: `pnpm dev` or `pnpm start`. Debug env: `GCTRL_ATTACH_DEBUG`, `GCTRL_RENDER_STATS`.

### Common Patterns
- Data flow: **db snapshots → worker merge → index AppState → lib filter/sort → ui factories → OpenTUI**.
- Mutations reverse: **index action → db stop/delete or `child_process` CLI → refresh**.
- Keyboard handler is modal-priority (Ctrl+C → stats → delete confirm → kill confirm → hierarchy → global → grid/detail).
- `types.ts` stays pure — no imports, no runtime logic.

## Dependencies

### Internal
- `db/*` — mutations + refresh protocol (not snapshot readers from index)
- `lib/*` — coordinator, filter/sort, attach, abort, signals, scroll, selection
- `ui/*` — SessionGrid, DetailPanel, HierarchyView, SessionCard constants
- `config/` — used by `ui/`, not imported by `index.ts` directly

### External
- `@opentui/core` — renderer, Box/ScrollBox/Text, styled text, key/mouse events
- Node: `child_process`, `fs`, `os`, `path`, `worker_threads`
- Indirect runtime: `node:sqlite` in worker; FFI via bin `--import`; host CLIs on PATH

<!-- MANUAL: -->
