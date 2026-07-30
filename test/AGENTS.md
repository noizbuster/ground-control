<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# test

## Purpose

Flat Vitest suite (no subdirectories) for gctrl unit/integration coverage and a gated Mission Control cross-process e2e. Tests import concrete `src/db`, `src/lib`, `src/ui`, and `src/types` modules. Vitest runs with `environment: "node"` and `globals: false`.

## Key Files

### Naming convention
| Pattern | Role |
|---------|------|
| `{domain}{Topic}.test.ts` | Unit/integration (camelCase), e.g. `codexSnapshot.test.ts` |
| `*.e2e.test.ts` | Cross-process e2e (self-skips without env) |
| `*Fixture.ts`, `*E2eSupport.ts`, `*E2eDatabase.ts`, `*ProtocolE2e.ts` | Shared helpers — not collected as tests |

### Fixtures & e2e support
| File | Description |
|------|-------------|
| `mcSqliteFixture.ts` | `createMcSqliteFixture` / `cleanupMcSqliteFixtures` — temp `mission-control.db` with relaxed schema |
| `mcTask11Fixture.ts` | Seeds `projection_runs`, `mission_runs`, `session_control_leases` |
| `missionControlChildAbortFixture.ts` | In-memory MC session/snapshot builders for unit abort tests |
| `missionControlChildAbortE2eSupport.ts` | Owner fixture process + spawn helpers (active/blocked/tree/noncooperative/owner-death) |
| `missionControlChildAbortE2eDatabase.ts` | E2E DB helpers: snapshot, expire leases, install projections, deleted IDs |
| `missionControlOwnerFixtureProtocolE2e.ts` | Owner fixture protocol helpers for e2e |
| `missionControlChildAbort.e2e.test.ts` | Cross-process MC child-only abort e2e (requires runner env) |
| `mcChildAbortE2eContract.test.ts` | Static contract: runner is shell-free; workflow pins 40-hex dual-repo refs |

### Domain clusters (representative)
| Cluster | Example files |
|---------|----------------|
| OpenCode / DB core | `opencodeSnapshot`, `opencodeIncremental`, `opencodeSessionStop`, `dbConnectionLifecycle`, `dbQueryHelpers`, `waitingSignalCandidates` |
| Codex | `codexSnapshot`, `codexWaitingStatus`, `codexSubagentTitle`, `codexStatePath`, `codexDelete`, `codexChildAbort` |
| Claude | `claudeSnapshot`, `claudeCache`, `claudeDelete` |
| Pi / OMP | `piSnapshot`, `piCache`, `piDelete`, `ompSessionStop` |
| Mission Control | `missionControlSnapshot`, `missionControlSqlite`, `missionControlCanonicalHierarchy`, `missionControlIdentitySnapshot`, `missionControlLeaseSnapshot`, `missionControlLifecycleSnapshot`, `missionControlRunOutcomeSnapshot`, `missionControlChildAbort`, `missionControlChildAbortValidation`, `missionControlAwaitedRefresh`, `missionControlStop`, `missionControlDelete` |
| Session list / abort / refresh | `sessionSource`, `sessionList`, `sessionCard`, `sessionStopShortcut`, `abortTargets`, `attachedSessionSignals`, `hierarchyHelpers`, `orphanedRunning`, `stallDetection`, `refreshCoordinator`, `refreshRenderSignature`, `boundedCache` |
| UI / OpenTUI | `detailTextSelection`, `scrollSectionBorders`, `gridScroll`, `gridColumnCount`, `colors` |

## Subdirectories

_None — keep the suite flat._

## For AI Agents

### Working In This Directory
- Import test APIs explicitly: `import { describe, expect, it } from "vitest"`.
- Prefer temp dirs (`mkdtempSync` + `afterEach` cleanup) or `createMcSqliteFixture`; avoid touching the developer's real `~/.codex` / `~/.claude` / MC DB.
- Mock `mc`/`mctrl`/`opencode`/`codex` via fake executables on `PATH` or injectable deps on stop/delete modules.
- OpenTUI renderer tests must import `../src/lib/ffi-register.mjs` first and use `@opentui/core/testing` (`createTestRenderer`).
- E2E must stay **shell-free** (`spawn`, `shell: false`) — enforced by `mcChildAbortE2eContract.test.ts`.
- Do not run MC e2e via bare `pnpm test` expectations; use the dedicated runner.

### Testing Requirements
```bash
pnpm test                                          # full unit/integration; e2e skips without env
pnpm exec vitest run test/codexSnapshot.test.ts    # single file
```
MC e2e (both repos built; absolute worktrees):
```bash
node scripts/run-mc-child-abort-e2e.mjs \
  --mc-worktree /abs/path/to/mission-control \
  --gc-worktree /abs/path/to/ground-control
```
Runner sets: `MC_WORKTREE`, `MC_CLI_ENTRY`, `MC_NATIVE_SIDECAR`, `MC_OWNER_FIXTURE_ENTRY`, `GCTRL_MC_E2E_TEMP_ROOT`, `MCTRL_DATA_DIR`, `XDG_RUNTIME_DIR`. Without `GCTRL_MC_E2E_TEMP_ROOT`, e2e registers `it.skip` only.

### Common Patterns
- Pure builders over live DBs when possible (`build*SessionSnapshot`, tree-token helpers, status mappers).
- Injectable seams on control-plane modules (`fetchImpl`, `mcExecutable`, `timeoutMs`, sleep, process list).
- MC lease tests pass deterministic `nowWallMs`.
- Pi/OMP delete race hooks exist for quarantine/unlink injection.
- Contract tests may source-read `scripts/` and `.github/workflows/` to lock release invariants.

## Dependencies

### Internal
- `src/db/*`, `src/lib/*`, `src/ui/*`, `src/types.ts`
- Fixtures compose MC schema tables used by production sqlite readers

### External
- `vitest` 4, `node:sqlite`, `@opentui/core` (+ `/testing`), Node `fs`/`path`/`child_process`
- E2E: external mission-control CLI + Rust sidecar from MC worktree

<!-- MANUAL: -->
