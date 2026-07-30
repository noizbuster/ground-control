<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# bench

## Purpose

Observational microbenchmarks. Not a CI gate. Used to compare OpenCode SQLite query shapes against a real or overridden database.

## Key Files

| File | Description |
|------|-------------|
| `opencode-query-bench.ts` | OLD vs NEW latest-message + count SQL microbench; honors `GCTRL_DB_PATH`; run via `pnpm run bench:opencode` |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Treat results as local evidence only — do not wire into `pnpm test` or CI.
- Prefer pointing at a fixture DB via `GCTRL_DB_PATH` rather than mutating the developer's live OpenCode DB.
- If query shapes in `src/db/index.ts` / `opencode.ts` change, update this bench to match.

### Testing Requirements
```bash
pnpm run bench:opencode
# or: GCTRL_DB_PATH=/path/to/opencode.db pnpm run bench:opencode
```

### Common Patterns
- `tsx` execution; read-only SQLite access.

## Dependencies

### Internal
- OpenCode path/SQL concepts from `src/db` (`DB_PATH` / query patterns)

### External
- `tsx`, `node:sqlite`

<!-- MANUAL: -->
