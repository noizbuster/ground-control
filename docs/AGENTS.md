<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# docs

## Purpose

Sparse operator and release documentation that is too detailed or process-oriented for the root README. Primary user docs remain `README.md` at repo root.

## Key Files

| File | Description |
|------|-------------|
| `mc-child-abort-release.md` | Mission Control child-stop paired-release contract: `mc session stop --child-only`, exit codes 0/1/2, guarded delete with `--expected-tree-token`, identity/lifecycle, local verification command, hosted multi-OS gate requirements |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- `mc-child-abort-release.md` is the **source of truth** for MC stop exit-code → fallback routing and release gates. Keep it aligned with `src/db/missionControlStop.ts`, `src/lib/missionControlChildAbort.ts`, `scripts/run-mc-child-abort-e2e.mjs`, and `.github/workflows/mc-child-abort-e2e.yml`.
- Do not claim hosted CI receipts unless authorized runs exist; the doc distinguishes local vs hosted gates.
- Prefer updating this doc when changing MC stop/delete contracts rather than burying process notes only in code comments.

### Testing Requirements
- Doc changes that alter contracts should be reflected in `test/mcChildAbortE2eContract.test.ts` and unit abort/validation tests.

### Common Patterns
- Operator-facing markdown; cross-link README “Mission Control Paired Release” section.

## Dependencies

### Internal
- Implementation: `src/db/missionControl*.ts`, `src/lib/missionControlChildAbort.ts`, `src/lib/missionControlFallbackPlan.ts`
- Runner/CI: `scripts/run-mc-child-abort-e2e.mjs`, `.github/workflows/mc-child-abort-e2e.yml`

### External
- Mission Control CLI (`mc` / `mctrl`) release pairing

<!-- MANUAL: -->
