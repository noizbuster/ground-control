<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# .github

## Purpose

GitHub project metadata and CI. Ground Control keeps a minimal Actions surface focused on the Mission Control child-abort paired-release gate.

## Key Files

_None at this level — workflows live in `workflows/`._

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `workflows/` | GitHub Actions workflow definitions (see `workflows/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Do not add push/PR noise workflows without need; the MC e2e gate is intentionally `workflow_dispatch` with immutable SHAs.
- Keep secrets/permissions minimal; dual-repo checkout must pin 40-hex refs (enforced by contract tests).

### Testing Requirements
- Contract coverage: `test/mcChildAbortE2eContract.test.ts` source-reads the workflow file.

### Common Patterns
- Manual release gates over always-on CI for cross-repo native builds.

## Dependencies

### Internal
- `workflows/` children; `scripts/run-mc-child-abort-e2e.mjs`; `docs/mc-child-abort-release.md`

### External
- GitHub Actions runners (ubuntu/macos/windows matrix for MC e2e)

<!-- MANUAL: -->
