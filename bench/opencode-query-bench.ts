// Observational micro-bench: OLD (2 separate queries) vs NEW (single MAX+join)
// for latest-message + count across all active OpenCode sessions.
//
// Run: `bun run bench:opencode`
// Honors GCTRL_DB_PATH via the shared DB_PATH resolver in src/db.
// NOT a CI gate; numbers are environment-specific and will vary by DB size.

import { Database } from "bun:sqlite";
import { DB_PATH } from "../src/db";

interface SessionIdRow {
	id: string;
}

const OLD_LATEST_QUERY = `
SELECT m.session_id, m.data
FROM message m
WHERE m.session_id IN (PLACEHOLDERS)
  AND m.rowid = (
    SELECT l.rowid
    FROM message l
    WHERE l.session_id = m.session_id
    ORDER BY l.time_created DESC, l.rowid DESC
    LIMIT 1
  )
`;

const OLD_COUNT_QUERY = `
SELECT session_id, COUNT(*)
FROM message
WHERE session_id IN (PLACEHOLDERS)
GROUP BY session_id
`;

const NEW_COMBINED_QUERY = `
WITH latest AS (
  SELECT session_id, MAX(time_created) AS mt, COUNT(*) AS cnt
  FROM message
  WHERE session_id IN (PLACEHOLDERS)
  GROUP BY session_id
)
SELECT m.session_id, m.data, m.rowid AS rid, latest.cnt
FROM message m
INNER JOIN latest
  ON latest.session_id = m.session_id
 AND m.time_created = latest.mt
`;

const run = (): void => {
	let db: Database | null = null;
	let ids: SessionIdRow[];
	try {
		db = new Database(DB_PATH, { readonly: true });
		ids = db
			.query<SessionIdRow, []>(
				"SELECT id FROM session WHERE time_archived IS NULL",
			)
			.all();
	} catch (error) {
		console.log(
			`error opening/querying DB at ${DB_PATH}: ${error instanceof Error ? error.message : error}`,
		);
		db?.close();
		return;
	}

	if (ids.length === 0) {
		console.log("no active sessions");
		db.close();
		return;
	}

	const idArr = ids.map((row) => row.id);
	const placeholders = idArr.map(() => "?").join(",");
	const oldLatestSql = OLD_LATEST_QUERY.replace("PLACEHOLDERS", placeholders);
	const oldCountSql = OLD_COUNT_QUERY.replace("PLACEHOLDERS", placeholders);
	const newCombinedSql = NEW_COMBINED_QUERY.replace(
		"PLACEHOLDERS",
		placeholders,
	);

	// OLD: 2 separate queries (correlated subquery + GROUP BY count).
	const t1 = performance.now();
	db.query(oldLatestSql).all(...idArr);
	db.query(oldCountSql).all(...idArr);
	const oldMs = performance.now() - t1;

	// NEW: MAX+join+COUNT in one query. Tie-break on identical time_created
	// is resolved in production code by keeping the highest rowid; the bench
	// only measures query latency, not the caller-side dedup.
	const t2 = performance.now();
	db.query(newCombinedSql).all(...idArr);
	const newMs = performance.now() - t2;

	console.log(`active_sessions=${idArr.length}`);
	console.log(`old (2 queries): ${oldMs.toFixed(1)} ms`);
	console.log(`new (1 MAX+join): ${newMs.toFixed(1)} ms`);
	console.log(
		`delta:           ${(oldMs - newMs).toFixed(1)} ms (${(((oldMs - newMs) / oldMs) * 100).toFixed(1)}%)`,
	);
	db.close();
};

run();
