<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# config

## Purpose

Agent identity chrome only: canonical agent names, display labels, hex colors, and override merge. No runtime I/O and no session logic.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Empty barrel (`export {}`) |
| `colors.ts` | `AGENT_COLOR_MAP`, `getCanonicalAgentName`, `getAgentDisplayName`, `getAgentColor`, `createAgentColorMap` / override merge |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Canonical agents include: atlas, build, compaction, explore, hephaestus, librarian, metis, momus, oracle, quick, prometheus, sisyphus, sisyphus-junior, unknown (extend map carefully — UI badges depend on it).
- Normalization: NFKC; strip ZWSP/ZWNJ/ZWJ/WJ/BOM; strip trailing `(…)`; lower-case; `_`/spaces → `-`.
- Alias match: exact or prefixes `name (` / `name - ` against canonical or display name.
- Unknown → gray `#888888`; display falls back to stripped raw or `"Unknown"`.
- Root sessions with unknown agent show **"Default"** via `ui/sessionAgentDisplay`, not this module.
- `createAgentColorMap` / `mergeAgentColorOverrides`: shallow merge by normalized lookup keys.

### Testing Requirements
- `test/colors.test.ts` — zero-width chars, aliases, overrides.

### Common Patterns
- Readonly maps; pure functions; `#${string}` branded hex.
- Empty barrel — import `./colors` (or `../config/colors`) directly.

## Dependencies

### Internal
- None beyond in-file types

### External
- None

### Consumers
- `src/ui/*`, `src/ui/sessionAgentDisplay.ts`

<!-- MANUAL: -->
