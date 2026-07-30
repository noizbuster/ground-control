<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# db

## Purpose

Multi-source session backend for gctrl. Owns read snapshots, the refresh worker thread, and destructive control (stop/delete/abort) for OpenCode, Codex, Claude Code, Pi, omp, and Mission Control. Does **not** own UI. Common result type: `DatabaseResult<T> = { ok:true, value } | { ok:false, error }` with codes `missing_database | database_access_denied | query_failed`.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | OpenCode SQLite primitives: path resolve, cached readonly `DatabaseSync`, statement cache, latest/count/waiting queries, `DatabaseResult` types |
| `opencode.ts` | Incremental OpenCode snapshot: `MAX(time_updated)` probe, hard-delete via live IDs, non-terminal re-poll, cache seed/merge |
| `opencode-session-stop.ts` | Staged OpenCode stop: discover servers → POST abort → ephemeral `serve` → CLI `run --session stop`; settle against DB status |
| `waitingSignalCandidates.ts` | Non-terminal session IDs eligible for waiting-signal queries |
| `pi.ts` | Pi + OMP JSONL adapters: root resolution, parse/cache, hierarchy/status, quarantine-safe recursive delete |
| `omp-session-stop.ts` | Linux `/proc` matcher; SIGINT only OMP processes resumed on the exact session JSONL path |
| `claude.ts` | Claude snapshot from project JSONL + live `sessions/` PIDs; refuse delete while active; artifact rm |
| `codex.ts` | Codex threads/edges from state SQLite + rollouts; status; tree-recursive delete (DB + rollouts + index) |
| `codex-child-abort.ts` | Codex `app-server` JSON-RPC: initialize → thread/resume → turn/interrupt |
| `missionControl.ts` | MC public barrel: snapshot + re-exports for path, delete, stop |
| `missionControlHelpers.ts` | Title truncate, project label, timestamp normalize |
| `missionControlSqlite.ts` | MC DB path precedence + `dbIdentity` (sha256 of canonical file URL) |
| `missionControlSqliteRows.ts` | Schema-tolerant readers: sessions, message counts, relations |
| `missionControlSqliteEvents.ts` | Event payload fallbacks for directory/title/model only (never lifecycle status) |
| `missionControlSqliteStatus.ts` | Map MC lifecycle → `SessionStatus` + detail |
| `missionControlSqliteLease.ts` | `session_control_leases` by `db_identity`; live vs expired; fallback safety |
| `missionControlSqliteRuntime.ts` | Per-session MC metadata: lifecycle, latest run, active work, lease, `abortable` |
| `missionControlSqliteTreeToken.ts` | Canonical BFS tree encoding + SHA-256 tree token for CAS delete |
| `missionControlSqliteHierarchy.ts` | Assemble trees; reject cycles/conflicts; stamp tokens; promote roots with open children |
| `missionControlSqliteSnapshot.ts` | End-to-end MC SQLite → `SessionSnapshot` |
| `missionControlDelete.ts` | Spawn `mc\|mctrl session delete [--force] [--expected-tree-token]` |
| `missionControlStop.ts` | Spawn `mc\|mctrl session stop <id> --child-only` with `MCTRL_DATA_DIR` |
| `refresh-worker.ts` | Worker entry: queue refresh/reset/ready; incremental OpenCode cache; merge all sources |
| `refresh-worker-protocol.ts` | Structured-clone-safe IPC types, factories, type guards |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

**Cross-source**
- Snapshots converge on `SessionSnapshot` (`sessions`, `statusBySessionId`, `messageCountBySessionId`, `sessionIssues`, `sourceIssues`).
- Soft-fail individual sources when ≥1 succeeds; hard worker error only when **zero** sources readable.
- Protocol payloads must stay structured-clone-safe.

**OpenCode**
- Long-lived readonly handle + statement cache; never close on the refresh hot path.
- Incremental probe uses `MAX(time_updated)`; hard deletes need `activeSessionIds` reconciliation every tick.
- Part-table waiting signals do not bump `time_updated` → pass `nonTerminalSessionIds` every tick.
- Stop stages: live abort → ephemeral serve abort → CLI stop-message; always settle via latest-message status.

**Pi / OMP**
- Shared dialect (`"pi" | "omp"`) with separate roots/entrypoints.
- OMP stop is path-exact only (never session-id-only); Linux `/proc`; SIGINT.
- Delete: quarantine-then-unlink with identity checks; OMP also quarantines sibling artifact dirs.

**Claude**
- Status prefers live PID; `AskUserQuestion` → waiting.
- Delete refuses while root still active.

**Codex**
- State DB: newest `state*.sqlite` under `~/.codex` unless overridden.
- Child abort needs a turn id (`lastTurnId` or in-progress); no turn → hard fail.

**Mission Control (critical invariants)**
- SQLite is the sole MC session source.
- `dbIdentity = sha256(fileUrl)` scopes leases.
- Lease missing table → `unknown` + `no_delete`; no row → `missing` + `eligible`; live expiry → `live` + `retry`.
- **Abortable**: `running|awaiting` always; `idle` only if `hasActiveWork`; never `stopped|failed`.
- Tree token: BFS, UTF-8 sibling order, SHA-256 — required for non-force CAS delete.
- Hierarchy rejects cycles/conflicts; unstable components become issues and are dropped from roots.
- Stop: `--child-only` only; never stop selected MC parent (app contract via `abortTargets`).
- Event fallbacks never override lifecycle status.
- Force `MCTRL_DATA_DIR=dirname(databasePath)` on stop/delete spawns.

**Refresh worker**
- Serial queue (`isProcessing`).
- `refresh-reset` clears OpenCode cache + Pi caches.
- OpenCode alone is incremental; all other sources full-read each tick.

### Env path overrides

| Variable | Effect |
|----------|--------|
| `GCTRL_DB_PATH` | OpenCode SQLite |
| `GCTRL_MC_DB_PATH` | MC DB (highest precedence) |
| `MCTRL_DATA_DIR` | MC data dir → `mission-control.db`; injected on stop/delete |
| `XDG_DATA_HOME` / `XDG_CONFIG_HOME` | Default roots for MC/OMP candidates |
| `GCTRL_PI_SESSIONS_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Pi roots |
| `GCTRL_OMP_SESSIONS_DIR`, `PI_CONFIG_DIR` | OMP roots |
| `GCTRL_CLAUDE_PROJECTS_DIR`, `GCTRL_CLAUDE_SESSIONS_DIR` | Claude roots |
| `GCTRL_CODEX_STATE_DB_PATH`, `GCTRL_CODEX_SESSIONS_DIR`, `GCTRL_CODEX_ARCHIVED_SESSIONS_DIR`, `GCTRL_CODEX_SESSION_INDEX_PATH` | Codex paths |

### Testing Requirements
- Prefer pure builders and `:memory:` / temp fixtures; injectable seams on stop modules.
- MC: deterministic `nowWallMs` for leases; `createMcSqliteFixture` in `test/`.
- Worker protocol: generation round-trip + type guards.
- See `test/AGENTS.md` for file clusters.

### Common Patterns
- `DatabaseResult` everywhere fallible paths.
- Readonly SQLite opens; OpenCode uniquely caches the handle (WAL).
- Bounded LRU/mtime caches on log parsers.
- Prefer external CLI/RPC for control over writing foreign DBs (except Codex metadata cleanup and FS deletes).

## Dependencies

### Internal
- `../types` — Session/status/MC metadata
- `../lib/sessionSnapshot`, `sessionSource`, `hierarchyHelpers`, `status`, `which`, `boundedCache`, `orphanedRunning`
- Within dir: adapters → `./index` errors/helpers; MC modules fan into snapshot/stop/delete; worker imports all `get*Snapshot`

### External
- `node:sqlite` (`DatabaseSync`), `fs`, `path`, `os`, `crypto`, `child_process`, `worker_threads`, `/proc` (Linux)
- Host binaries: `opencode`, `codex`, `mc`/`mctrl` (via `which`)

<!-- MANUAL: -->
