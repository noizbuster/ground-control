<p align="center">
  <img src="./banner.png" alt="Ground Control banner" width="50%" />
</p>

# Ground Control

`gctrl` is a terminal TUI for monitoring OpenCode sessions in real time. It reads the local OpenCode SQLite database in read-only mode and presents session status, active agents, subagent activity, and recent updates in a card-based interface.

## Quick Start

Make sure these are available before running `gctrl`:

- `bun` 1.1 or later
- OpenCode installed and used on the same machine
- `~/.local/share/opencode/opencode.db` exists

### Run with `bunx`

```bash
bunx gctrl
```

### Run with `npx`

```bash
npx gctrl
```

Note: `npx gctrl` still requires `bun` in your `PATH` because the packaged CLI launches `dist/index.js` with Bun internally.

<p align="center">
  <img src="./demo.png" alt="demo image of gctrl" width="75%" />
</p>

## Overview

- Displays OpenCode sessions in a responsive card grid
- Refreshes automatically every 2 seconds
- Visualizes activity with per-agent colors
- Highlights sessions waiting for user input with a pulse effect
- Shows session metadata and subagent information in a detail panel
- Supports attach, copy ID, delete, filter, sort, and sideview controls from the keyboard

## Usage

After launch, use these shortcuts to navigate and control the monitor:

| Key | Action |
| --- | --- |
| `j` / `k` / `Up` / `Down` | Move selection or scroll the detail pane |
| `Enter` | Open the detail view |
| `e` / `p` | Toggle sideview |
| `f` | Cycle filter mode |
| `s` | Cycle sort mode |
| `a` | Attach to the selected session |
| `i` | Copy the selected session ID |
| `d` | Delete the selected session |
| `Tab` | Switch focus between the grid and detail pane |
| `Esc` / `q` | Close the detail view or quit |
| `Ctrl+C` | Quit immediately |

## Requirements

- Bun is required because `bin/gctrl.js` runs `dist/index.js` through the Bun runtime.
- The monitor reads session data from `~/.local/share/opencode/opencode.db`.
- Attach and delete actions use the `opencode` CLI, so `opencode` should be available in your `PATH`.

## Local Development

```bash
bun install
bun run dev
```

Useful scripts:

```bash
bun run start
bun run dev
bun run build
bun run typecheck
bun run lint
bun run check
```

## Project Structure

```text
bin/          CLI wrapper
src/db/       OpenCode SQLite read-only access
src/ui/       TUI components
src/config/   color and agent configuration
src/lib/      status detection logic
dist/         compiled output
```

## License

MIT

---

<p align="center">
  <strong>Supervised by NoizBuster, Written by OpenCode</strong>
</p>

