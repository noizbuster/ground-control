<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# lib

## Purpose

Domain utilities and OpenTUI/runtime glue: session status, multi-source capabilities, hierarchy pure logic, refresh coordination, abort/kill planning, grid keyboard/scroll math, attached-process detection, and the **koffi FFI bridge** that lets `@opentui/core` run on Node without `node:ffi`. Barrels are empty — import concrete modules.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Empty barrel (`export {}`) — do not rely on re-exports |
| `ffi-register.mjs` | Node `--import` entry: ESM resolve hook + `Module._load` patch for `node:ffi`→koffi; filters koffi uncaughtException noise |
| `ffi-esm-hooks.mjs` | ESM resolve short-circuits `import("node:ffi")` to the CJS adapter |
| `ffi-koffi-adapter.cjs` | CJS `NodeFfiBackend`: TYPE_MAP, dlopen, getRawPointer, live `koffi.view`, registerCallback |
| `opentuiSelectionPatch.ts` | Monkey-patches `TextBufferView.prototype.getSelection` for packed bigint selection info |
| `status.ts` | `MessageData` → `SessionStatus` precedence (failed/completed/waiting/running) |
| `sessionSnapshot.ts` | `buildSessionSnapshot` (OpenCode-shaped) + `mergeSessionSnapshots` for multi-source worker |
| `sessionSource.ts` | Per-source capabilities, labels/colors, attach launch specs, binary resolve |
| `sessionList.ts` | Filter modes `active\|recent\|busy\|all`, sort `status\|update\|create`, directory pins |
| `hierarchyHelpers.ts` | Pure hierarchy filter/flatten, tree\|flow lines, AWAITING SUBAGENT labels |
| `attachedSessionSignals.ts` | Parse process lists for externally attached session IDs across sources |
| `refreshCoordinator.ts` | Serial refresh queue: request/settle/shouldApplyResponse; `RefreshCompletionError` |
| `refreshRenderSignature.ts` | FNV-1a signature to skip redundant renders |
| `abortTargets.ts` | K-key abort plan: MC children-only; OpenCode/Codex may include non-terminal root |
| `missionControlChildAbort.ts` | `prepareMissionControlChildAbort` + fallback execute; deps-injected |
| `missionControlFallbackPlan.ts` | Build MC delete fallback plan from snapshot tree tokens/lifecycle |
| `killFallbackRoute.ts` | Route kill fallback: mission-control \| stale-mission-control \| codex \| opencode |
| `gridScroll.ts` | Grid row math, scroll clamp, keyboard selection; imports UI layout constants |
| `boundedCache.ts` | Map LRU helpers for db session file caches |
| `stallDetection.ts` | Stall levels none/stalled(5m)/blocked(10m) |
| `recentCompletion.ts` | Timestamp normalize + 10m recent-completion window |
| `orphanedRunning.ts` | Orphaned running after 5m inactivity |
| `detailMouse.ts` | Detail pane mouse: right-click closes (non-sideview); left focuses |
| `textSelection.ts` | Selection text + in-progress (`isDragging` only — OpenTUI leaves `isStart` sticky) |
| `sessionStopShortcut.ts` | Ctrl+K / Shift+K / VT `\u000b` |
| `which.ts` | PATH binary resolver (Bun.which replacement) |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Prefer pure functions; inject deps for process I/O (MC abort, which, signals).
- `buildSessionSnapshot` hardcodes `sessionSource: "opencode"` — other sources build their own snapshots in `db/*` and merge via `mergeSessionSnapshots`.
- **Abort contract:** Mission Control never stops the selected parent; only children with `sourceMetadata.missionControl.abortable === true`. OpenCode/Codex may stop selected non-terminal root after children.
- **attachedSessionSignals:** bare `mc` collides with Midnight Commander — require explicit session/mctrl paths; prefilter via `isSessionProcessComm`.
- **refreshCoordinator:** only apply when `shouldApplyResponse(requestId)`; settle ok/error; `cancel` rejects waiters.
- `gridScroll` depends on `ui/SessionCard` + `ui/SessionGrid` constants (intentional reverse dep for shared geometry).
- Timestamps: `normalizeTimestamp` treats values `< 1e12` as seconds.

### FFI / koffi constraints (critical)
1. Launch with `node --import …/ffi-register.mjs` (see `bin/gctrl.js`). Both ESM resolve and CJS `Module._load` patches required.
2. Adapter stays **CJS** so `Module._load` can return it synchronously.
3. `toArrayBuffer` must return **live** `koffi.view` when `copy=false` (struct R/W).
4. Map `bool` to **`uint8_t`** (OpenTUI passes Number 0/1).
5. Callbacks: named `koffi.proto` then `koffi.register` — anonymous protos rejected.
6. **Node 24 rendering:** comments warn koffi **3.0.x segfaults** in `register()`; live TUI historically needed koffi 2.x pin. `package.json` may list 3.x — treat pin vs comment as drift when debugging crashes.
7. `close()` must not `koffi.unload` (UAF risk).
8. FFI files are **not tsc-emitted**; `scripts/copy-hooks.mjs` copies them to `dist/lib/`. Edit `.mjs/.cjs` in place.
9. Call `patchTextBufferViewSelection()` once at app start.

### Testing Requirements
- Heavy unit coverage under `test/`: sessionList, sessionSource, hierarchyHelpers, abortTargets, attachedSessionSignals, boundedCache, gridScroll, stallDetection, orphanedRunning, refreshCoordinator, refreshRenderSignature, sessionStopShortcut, missionControlChildAbort*, detailTextSelection (with ffi-register + OpenTUI test renderer).

### Common Patterns
- Pure TS + injectable deps; `Readonly` plans; discriminated unions.
- Map insertion-order LRU; FNV-1a unsigned hashes for signatures.
- Empty `index.ts` barrel everywhere in lib/ui/config.

## Dependencies

### Internal
- `../types`
- `../db` (+ missionControl*, refresh-worker-protocol) from abort/fallback modules
- `../ui/SessionCard`, `../ui/SessionGrid` (geometry constants only from `gridScroll`)

### External
- `@opentui/core`, `koffi`, `node:fs`/`path`/`module`

<!-- MANUAL: -->
