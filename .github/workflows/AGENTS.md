<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# workflows

## Purpose

GitHub Actions workflow definitions. Currently a single manual release gate for Mission Control child-abort cross-repo e2e.

## Key Files

| File | Description |
|------|-------------|
| `mc-child-abort-e2e.yml` | `workflow_dispatch` only: inputs `mc_ref` + `gc_ref` (40-hex SHAs); matrix ubuntu/macos/windows (`fail-fast: false`); checkout both repos; Node 26.3 + Rust; build MC CLI/sidecar + GC; run `scripts/run-mc-child-abort-e2e.mjs` |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Keep refs immutable (full 40-hex). Contract test `test/mcChildAbortE2eContract.test.ts` locks dual-repo pin + separate checkouts.
- Not on push/PR — intentional paired-release gate (see `docs/mc-child-abort-release.md`).
- Align runner invocation with `scripts/run-mc-child-abort-e2e.mjs` flags and required MC artifact paths.
- Do not weaken `shell: false` / spawn-only e2e execution from CI.

### Testing Requirements
- Static: `pnpm exec vitest run test/mcChildAbortE2eContract.test.ts`
- Full gate: dispatch workflow with authorized SHAs; do not claim hosted receipts without runs.

### Common Patterns
- Dual checkout of mission-control + ground-control at pinned SHAs.
- Build native MC sidecar (Rust) before e2e.

## Dependencies

### Internal
- `scripts/run-mc-child-abort-e2e.mjs`
- `test/missionControlChildAbort.e2e.test.ts`
- `docs/mc-child-abort-release.md`

### External
- GitHub Actions; Node 26.3; Rust toolchain; pnpm; mission-control repository

<!-- MANUAL: -->
