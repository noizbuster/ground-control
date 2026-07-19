<p align="center">
  <img src="./banner.png" alt="Ground Control banner" width="50%" />
</p>

# Ground Control

`gctrl` is a terminal TUI for monitoring OpenCode, Codex, Claude Code, Pi, omp, and Mission Control sessions in real time. It presents session status, active agents, subagent activity, richer source metadata, and recent updates in one card-based interface, while also supporting source-native session deletion flows where the upstream CLI exposes them and conservative local cleanup for file-backed sources.

## Quick Start

Make sure these are available before running `gctrl`:

- Node.js 24 or later
- OpenCode, Codex, Claude Code, Pi, omp, and/or Mission Control installed on the same machine
- `~/.local/share/opencode/opencode.db` exists for OpenCode monitoring
- `~/.codex/state_*.sqlite` and `~/.codex/sessions/` exist for Codex monitoring
- `~/.claude/projects/` and/or `~/.claude/sessions/` exist for Claude Code monitoring
- `~/.pi/agent/sessions/` exists for Pi monitoring
- `~/.omp/agent/sessions/` exists for omp monitoring
- `~/.local/share/mission-control/mission-control.db` exists for Mission Control monitoring

### Run with `npx`

```bash
npx gctrl
```

<p align="center">
  <img src="./demo.png" alt="demo image of gctrl" width="75%" />
</p>

<p align="center">
  <img src="./demo2.png" alt="demo image of gctrl" width="75%" />
</p>

## Overview

- Displays OpenCode, Codex, Claude Code, Pi, omp, and Mission Control sessions in a live terminal list
- Refreshes automatically every 2 seconds
- Shows status, source, project label, session ID, update time, and richer source metadata
- Supports source-aware actions, copy ID, refresh, and keyboard navigation

## Usage

After launch, use these shortcuts to navigate and control the monitor:

| Key | Action |
| --- | --- |
| `h` / `j` / `k` / `l` / `←` / `↑` / `↓` / `→` | Move selection in the session grid |
| `PgUp` / `PgDn` | Jump selection by a page of rows in the session grid (or scroll detail/hierarchy by one page) |
| `j` / `k` / `↑` / `↓` (detail focus) | Scroll session detail |
| `Tab` | Switch focus between grid and detail pane (when sideview is enabled) |
| `Enter` | Open the selected session detail view |
| `e` / `p` | Toggle sideview layout |
| `f` | Cycle session filter mode (`active → recent → busy → all`) |
| `s` | Cycle sort mode (`status → update → create`) |
| `c` | Open hierarchy view |
| `t` | Open hierarchy directly in timeline view |
| `a` | Attach to the selected session |
| `i` | Copy the selected session ID |
| `K` | Stop stuck/active sessions for the selection (children +, for OpenCode/Codex, a non-terminal selected parent). Graceful stop first; delete fallback on failure |
| `d` | Request delete for the selected session |
| `y` / `n` | Confirm or cancel delete prompt |
| `r` | Refresh immediately |
| `Ctrl+S` | Toggle session stats modal (per-source and per-status breakdown) |
| `Esc` / `q` | Cancel prompt, close current view, or quit from the main view |
| `Ctrl+C` | Quit immediately |

### Stop Stuck/Active Sessions (`K`)

Press `K` (Shift+K) from the main grid, detail, or sideview to stop stuck or still-active sessions under the selection.

- **OpenCode / Codex**: stops every non-terminal child/descendant, and also stops the selected parent when the parent itself is non-terminal (running/waiting/pending/unknown/idle). This covers unfinished compaction, zombie busy roots, and mid-stream hangs.
- **Mission Control**: stops abortable children only. The selected Mission Control parent is never stopped (existing contract).

Codex, Claude Code, Pi, and omp sessions support attach/inspect/copy/hierarchy/delete flows. Session-stop is supported for OpenCode, Codex, and Mission Control sessions. Codex attach uses `codex resume <session-id>`, Claude Code attach uses `claude --resume <session-id>`, Pi attach uses `pi --session <session-id>` for roots and the exact session JSONL path for child artifacts, and omp attach uses `omp --resume <session-jsonl-path>` when the JSONL path is known, falling back to the session ID only when no path is available. Attach falls back to the current monitor directory if the original session directory no longer exists. Claude Code subagent attach resolves back to the root session because the upstream CLI resumes root conversations by ID. Mission Control attach uses `mc --session <session-id>` (`mctrl` is honored as a legacy alias/fallback).

OpenCode keeps its source-native two-stage flow:

1. **Graceful stop**: sends a "stop" message to each target session via `opencode run --session <id> stop`, which triggers normal completion (`finish: "stop"`).
2. **Delete fallback**: if graceful stop fails for any target, a per-item confirmation dialog appears where you can choose to delete (`y`), skip (`n`), or cancel all (`Esc`/`q`).

Mission Control uses one awaited `mc session stop <parent> --child-only` command with `MCTRL_DATA_DIR` set to the selected database's parent. `mctrl` is used only when `mc` is unavailable. Exit `0` completes without a fallback. Exit `2`, a launch failure, a refresh failure, or an unstable hierarchy never opens a fallback. Only exit `1` triggers a fresh snapshot of still-abortable descendants: missing or expired leases may enter confirmation; a live lease shows `Owner still active; retry stop`; unknown lease authority is no-delete. Before deletion, Ground Control takes a second snapshot and requires the same eligible members, raw statuses, lease safety, and tree tokens. Each confirmed minimal subtree root is deleted once with a non-force guarded command and its refreshed token. `K` never stops its selected Mission Control parent and never routes a Mission Control fallback through OpenCode.

### Session Filter Modes (`f`)

- `active`: non-completed sessions, plus externally attached completed sessions. Directory-count fallback is applied as **non-complete first**, and only remaining slots can surface latest completed sessions.
- `recent`: everything visible in `active`, plus (1) the globally latest completed session and (2) each project's latest updated session.
- `busy`: non-completed sessions only.
- `all`: all sessions.

### Hierarchy View (`c`)

Press `c` on a selected session to open the agent hierarchy view, or press `t` to open it directly in timeline mode. This shows the session's subagent tree with status, timing, and metadata.

| Key | Action |
| --- | --- |
| `Tab` | Cycle view mode (tree / timeline) |
| `x` | Cycle info mode (standard / detailed) |
| `f` | Cycle filter mode (latest / busy / all) |
| `←` / `→` / `h` / `l` | Pan timeline (timeline mode only) |
| `j` / `k` / `Up` / `Down` | Scroll |
| `PgUp` / `PgDn` | Scroll by one page |
| `Esc` / `q` | Close hierarchy view |

## Requirements

- Node.js 24+ is required for built-in `node:sqlite`.
- The native TUI renderer uses a koffi-based FFI adapter (no manual flags needed).
- The monitor reads OpenCode session data from `~/.local/share/opencode/opencode.db`.
- The monitor reads Codex thread state from the newest `~/.codex/state_*.sqlite` file and enriches it with `~/.codex/sessions/**/*.jsonl`.
- The monitor reads Claude Code session state from `~/.claude/sessions/*.json` and enriches it with `~/.claude/projects/**/*.jsonl`.
- The monitor reads Pi JSONL sessions from `~/.pi/agent/sessions/**/*.jsonl`.
- The monitor reads omp JSONL sessions from `~/.omp/agent/sessions/**/*.jsonl`.
- The monitor reads Mission Control session state from the SQLite store at `~/.local/share/mission-control/mission-control.db`. If that database is missing or unreadable, Mission Control sessions are not shown.
- Override the OpenCode database path with `GCTRL_DB_PATH=/custom/path/opencode.db`.
- Override Codex paths with `GCTRL_CODEX_STATE_DB_PATH=/custom/path/state.sqlite`, `GCTRL_CODEX_SESSIONS_DIR=/custom/path/sessions`, `GCTRL_CODEX_ARCHIVED_SESSIONS_DIR=/custom/path/archived_sessions`, and `GCTRL_CODEX_SESSION_INDEX_PATH=/custom/path/session_index.jsonl`.
- Override Claude Code paths with `GCTRL_CLAUDE_PROJECTS_DIR=/custom/path/projects` and `GCTRL_CLAUDE_SESSIONS_DIR=/custom/path/sessions`.
- Override Pi sessions with `GCTRL_PI_SESSIONS_DIR=/custom/path/sessions`; `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` are also honored.
- Override omp sessions with `GCTRL_OMP_SESSIONS_DIR=/custom/path/sessions`; `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, and XDG omp candidates are also honored.
- Override the Mission Control SQLite database with `GCTRL_MC_DB_PATH=/custom/path/mission-control.db` (primary); `MCTRL_DATA_DIR=/custom/path` is also honored and resolves to `<MCTRL_DATA_DIR>/mission-control.db`, and `XDG_DATA_HOME` is honored for the default `~/.local/share/mission-control/mission-control.db` location.
- OpenCode attach/delete/child-abort actions use the `opencode` CLI.
- Codex attach/delete/child-abort actions use the local `codex` CLI and app-server protocol.
- Claude Code attach actions use the local `claude` CLI.
- Pi attach actions use the local `pi` CLI; Pi delete removes the selected JSONL session and any loaded descendant JSONL sessions.
- omp attach actions use the local `omp` CLI; omp delete removes the selected JSONL session, loaded descendant JSONL sessions, and sibling artifact directories, but not shared blob storage.
- Mission Control attach actions use the local `mc` CLI (`mctrl` is honored as a legacy alias/fallback). Mission Control delete removes a canonical descendant subtree and is destructive. Ground Control sends `mc session delete <id> --expected-tree-token <sha256>` only after the two-refresh confirmation flow; a changed tree or live lease refuses the non-force delete.
- Codex delete uses the local `codex app-server` archive flow plus cleanup of archived rollout files and local index/state entries.
- Claude Code delete intentionally refuses live sessions, then removes matching `projects/`, `file-history/`, `session-env/`, `tasks/`, and stale `sessions/*.json` artifacts from local `.claude/` storage. This follows the official `.claude` storage guidance: Claude Code does not expose a delete subcommand, but its local session data can be removed directly.
- Non-interactive mode (missing TTY stdin/stdout) prints a tab-separated snapshot and exits.

## Local Development

```bash
pnpm install
pnpm dev
```

Useful scripts:

```bash
pnpm start
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
pnpm check
pnpm test
```

## Mission Control Paired Release

Mission Control session stop and Ground Control's Mission Control `K` path are a synchronized release pair. Ground Control uses `mc` first and falls back to the `mctrl` alias only when `mc` is unavailable. It does not inspect command versions, help text, or capabilities to select a behavior.

The current Linux implementation verification is local: the isolated cross-repository runner passed the five documented scenarios. The immutable-SHA Linux, macOS, and Windows workflow is a separate post-authorization release gate. No hosted run is claimed here; until explicit authorization produces hosted receipts, that gate is pending. See [`docs/mc-child-abort-release.md`](docs/mc-child-abort-release.md) for the operator and release contract.

## Project Structure

```text
bin/          CLI wrapper
src/db/       OpenCode + Codex + Claude Code + Pi/omp + Mission Control data adapters
src/ui/       TUI components
src/config/   color and agent configuration
src/lib/      status detection logic
dist/         compiled output
```

## Session Status Detection

OpenCode status is derived from the latest message in the OpenCode SQLite database. The detection pipeline reads the most recent `message` row per session, parses its JSON `data` column, and applies status detectors in priority order. Codex status is mapped conservatively from thread/task events plus `thread_spawn_edges`, Claude Code status is mapped from local session registries plus JSONL conversation logs and subagent transcripts, and Pi/omp status is mapped conservatively from JSONL message/model/thinking events. Richer raw detail is surfaced separately in the UI.

### Status Priority

| Priority | Status | Condition |
|---|---|---|
| 1 | `failed` | `finish === "error"` |
| 2 | `waiting` | Question tool is running AND no user response yet (see Waiting Detection below) |
| 3 | `completed` | `finish === "stop"` OR `time.completed` is a finite number |
| 4 | `running` | Not failed, not waiting, not completed |
| 5 | `unknown` | Message data is null, empty, or failed JSON parsing |

### Finish Values

The `finish` field on the latest message indicates how the session step ended:

| `finish` | `time.completed` | Detected Status | Display Label |
|---|---|---|---|
| `stop` | — | `completed` | Completed |
| `tool-calls` | absent | `running` | Running |
| `error` | — | `failed` | Failed |
| `other` | present | `completed` | Completed (other) |
| `length` | present | `completed` | Completed (length) |
| `unknown` | present | `completed` | Completed (unknown) |
| _undefined_ | absent | `running` | Running |
| _no message_ | — | `unknown` | Unknown |

When `finish` is `"other"`, `"length"`, or `"unknown"`, the status label appends the reason in parentheses — e.g. `Completed (other)`, `Completed (length)`.

### Waiting Detection

A session is `waiting` when the question tool is active and awaiting user input. This uses a secondary signal from the `part` table:

1. Find the latest `part` row with `type === "tool"` and `tool === "question"` where `state.status === "running"`
2. Compare its timestamp against the latest user message time
3. If the question tool time is newer → `waiting` (overrides `running`)

Waiting never overrides `failed` or `completed`.

### Display Override: AWAITING SUBAGENT

A `completed` root session that has running child sessions displays as **AWAITING SUBAGENT** instead of Completed. This reflects that the parent is technically done but work continues in subagents. The effective status becomes `running` for filtering and sorting purposes.

### Hierarchy Filter: Latest Mode

In the hierarchy view's "latest" filter mode, subagent sessions are filtered as follows:

- **Active** subagents (pending/running/waiting) are always shown
- **AWAITING SUBAGENT** subagents (completed with active children) are always shown
- **Terminal** subagents (completed/failed/unknown with no active children) — only the most recently updated one is shown

## License

MIT

---

<p align="center">
  <strong>Supervised by NoizBuster, Written by OpenCode</strong>
</p>
