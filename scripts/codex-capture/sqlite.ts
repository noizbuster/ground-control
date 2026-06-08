import { getString, isRecord, runCommand } from "./shared";

const parseJsonRows = (stdout: string): readonly Record<string, unknown>[] => {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return [];
	}
	const parsed: unknown = JSON.parse(trimmed);
	return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
};

export const sqliteJson = async (
	dbPath: string,
	sql: string,
): Promise<readonly Record<string, unknown>[]> => {
	const result = await runCommand(["sqlite3", "-json", dbPath, sql]);
	if (result.exitCode !== 0) {
		return [{ error: result.stderr, sql }];
	}
	return parseJsonRows(result.stdout);
};

const quoteSqlIdentifier = (value: string): string =>
	`"${value.replace(/"/gu, '""')}"`;

const sqlString = (value: string): string => `'${value.replace(/'/gu, "''")}'`;

const relatedCte = (sessionId: string): string => `
WITH RECURSIVE related(id) AS (
  SELECT ${sqlString(sessionId)}
  UNION
  SELECT child_thread_id
  FROM thread_spawn_edges
  JOIN related ON thread_spawn_edges.parent_thread_id = related.id
  UNION
  SELECT parent_thread_id
  FROM thread_spawn_edges
  JOIN related ON thread_spawn_edges.child_thread_id = related.id
)`;

export const collectRelatedThreads = (
	dbPath: string,
	sessionId: string,
): Promise<readonly Record<string, unknown>[]> =>
	sqliteJson(
		dbPath,
		`${relatedCte(sessionId)}
SELECT
  CASE
    WHEN threads.id = ${sqlString(sessionId)} THEN 'self'
    WHEN threads.id IN (
      SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ${sqlString(sessionId)}
    ) THEN 'descendant'
    ELSE 'related'
  END AS relation,
  threads.*
FROM related
LEFT JOIN threads ON threads.id = related.id
ORDER BY relation, threads.id;`,
	);

export const collectRelatedEdges = (
	dbPath: string,
	sessionId: string,
): Promise<readonly Record<string, unknown>[]> =>
	sqliteJson(
		dbPath,
		`${relatedCte(sessionId)}
SELECT *
FROM thread_spawn_edges
WHERE parent_thread_id IN (SELECT id FROM related)
   OR child_thread_id IN (SELECT id FROM related)
ORDER BY parent_thread_id, child_thread_id;`,
	);

export const collectLogPaths = async (
	sessionId: string,
	sessionsDir: string,
	threadRows: readonly Record<string, unknown>[],
): Promise<readonly string[]> => {
	const paths = new Set<string>();
	for (const row of threadRows) {
		const rolloutPath = getString(row, "rollout_path");
		if (rolloutPath) {
			paths.add(rolloutPath);
		}
	}

	const findResult = await runCommand([
		"find",
		sessionsDir,
		"-type",
		"f",
		"-name",
		`*${sessionId}*.jsonl`,
	]);
	if (findResult.exitCode === 0) {
		for (const line of findResult.stdout.split(/\r?\n/u)) {
			if (line.trim()) {
				paths.add(line.trim());
			}
		}
	}

	return [...paths].sort();
};

export const captureRelatedRows = async (
	dbPath: string,
	relatedIds: ReadonlySet<string>,
): Promise<Record<string, readonly Record<string, unknown>[]>> => {
	const tables = await sqliteJson(
		dbPath,
		"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
	);
	const output: Record<string, readonly Record<string, unknown>[]> = {};
	for (const table of tables) {
		const name = getString(table, "name");
		if (!name) {
			continue;
		}
		const rows = await sqliteJson(
			dbPath,
			`SELECT * FROM ${quoteSqlIdentifier(name)};`,
		);
		output[name] = rows.filter((row) => {
			const text = JSON.stringify(row);
			for (const id of relatedIds) {
				if (text.includes(id)) {
					return true;
				}
			}
			return false;
		});
	}
	return output;
};
