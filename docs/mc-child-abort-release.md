# Mission Control Child Stop Release Contract

## Operator Contract

Ground Control and Mission Control ship the session-stop capability as a synchronized pair. Ground Control invokes `mc` first and uses `mctrl` only when `mc` is unavailable. It does not select behavior through command version, help text, or capability detection.

For a selected Mission Control parent, `K` invokes exactly one command against the selected database:

```text
mc session stop <parent> --child-only
```

The selected parent stays active. Descendants are resolved recursively through the canonical hierarchy. Terminal descendants are no-ops but remain traversable. The command emits one aggregate summary line and exits `0` for complete success or no-op, `1` for partial or runtime failure, and `2` for usage error. Ground Control does not parse per-session results.

Only exit `1` can open the destructive fallback. Ground Control takes a fresh snapshot, considers only still-abortable descendants, and groups them by minimal canonical subtree root. Missing or expired leases are eligible for confirmation. A live lease displays `Owner still active; retry stop`; unknown lease authority is no-delete. Exit `0`, exit `2`, launch failure, refresh failure, and an unstable hierarchy do not open fallback.

After confirmation, Ground Control takes a second snapshot. The eligible set, raw status, lease safety, and every affected tree token must match the first snapshot. It then issues one non-force guarded deletion per confirmed minimal root:

```text
mc session delete <root> --expected-tree-token <sha256>
```

Mission Control recomputes the canonical subtree and token in the same transaction as deletion. A changed tree or unexpired lease rejects deletion. The delete is recursive and destructive: it removes the confirmed root's canonical descendants and their session rows, projections, and compatibility artifacts. It is not an abort operation.

## Identity And Lifecycle

The selected database path determines the shared identity. Mission Control and Ground Control canonicalize the path, convert it to a file URL, and use lowercase SHA-256 of its UTF-8 `href` as `dbIdentity`. Ground Control passes the selected database parent as `MCTRL_DATA_DIR` for both stop and guarded delete.

A successful stop is resumable. The session converges to `idle (aborted)`, not terminal completion. `session_events` owns session, run, approval, and input history; `mission_runs` owns mission work; and `async_jobs` owns durable job work. Idle requires all three authorities to be quiescent. Tools remain failed with `operator_aborted`; provider aborts remain in audit history without creating provider-outage rows.

## Verification And Release Gate

Local implementation verification uses the isolated worktrees and the exact current-OS runner:

```bash
source .omo/evidence/task-1-worktrees.env
node "$GC_WORKTREE/scripts/run-mc-child-abort-e2e.mjs" --mc-worktree "$MC_WORKTREE" --gc-worktree "$GC_WORKTREE"
```

The recorded Linux result is 5/5 scenarios passed: fixture protocol, active and blocked settlement, child-only behavior across two database identities, partial timeout with stale-settlement fencing, and owner-death guarded deletion. This is local verification only.

The hosted release gate is pending post-authorization. It requires immutable 40-hex Mission Control and Ground Control revisions, separate checkouts, and the same runner on Linux, macOS, and Windows. No hosted execution result is claimed without its receipts.
