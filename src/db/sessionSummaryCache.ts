import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SessionSummaryCacheSource = "pi" | "omp" | "codex";

export interface SessionSummaryFileIdentity {
	readonly canonicalPath: string;
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
}

export type SessionSummaryCacheHit<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "issue"; readonly issue: string };

interface SessionSummaryCacheRow {
	canonical_path: string;
	dev: string;
	ino: string;
	mtime_ms: number;
	size: number;
	parser_version: number;
	payload_json: string | null;
	issue: string | null;
}

const CACHE_SCHEMA_VERSION = 1;
export const SESSION_SUMMARY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_DIRECTORY_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;
const EVICTION_BATCH_SIZE = 128;
const CACHE_AUXILIARY_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

const getDefaultCachePath = (): string => {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cacheRoot, "gctrl", "session-summaries.sqlite");
};

export const resolveSessionSummaryCachePath = (): string =>
	resolve(
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH || getDefaultCachePath(),
	);

interface PendingSummaryWrite {
	readonly source: SessionSummaryCacheSource;
	readonly cacheKey: string;
	readonly identity: SessionSummaryFileIdentity;
	readonly parserVersion: number;
	readonly payloadJson: string | null;
	readonly issue: string | null;
	readonly updatedAt: number;
	readonly byteLength: number;
}

const removeCacheStorage = (path: string): void => {
	for (const suffix of ["", ...CACHE_AUXILIARY_SUFFIXES]) {
		try {
			rmSync(`${path}${suffix}`, { force: true });
		} catch {}
	}
};
const WRITE_BATCH_MAX_ENTRIES = 64;
const WRITE_BATCH_MAX_BYTES = 1024 * 1024;

const getStorageBytes = (path: string): number => {
	let bytes = 0;
	for (const suffix of ["", ...CACHE_AUXILIARY_SUFFIXES]) {
		try {
			bytes += statSync(`${path}${suffix}`).size;
		} catch {}
	}
	return bytes;
};

const ensurePrivateCacheTarget = (path: string): void => {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: CACHE_DIRECTORY_MODE });
	chmodSync(directory, CACHE_DIRECTORY_MODE);
};

const readUserVersion = (database: DatabaseSync): number => {
	const row = database.prepare("PRAGMA user_version").get() as
		| { user_version?: number }
		| undefined;
	return row?.user_version ?? 0;
};

const initializeSchema = (database: DatabaseSync): void => {
	database.exec(`
		PRAGMA auto_vacuum = INCREMENTAL;
		CREATE TABLE IF NOT EXISTS session_summary_cache (
			source TEXT NOT NULL,
			cache_key TEXT NOT NULL,
			canonical_path TEXT NOT NULL,
			dev TEXT NOT NULL,
			ino TEXT NOT NULL,
			mtime_ms REAL NOT NULL,
			size INTEGER NOT NULL,
			parser_version INTEGER NOT NULL,
			payload_json TEXT,
			issue TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (source, cache_key)
		);
		CREATE INDEX IF NOT EXISTS session_summary_cache_updated_at
			ON session_summary_cache(updated_at);
		PRAGMA user_version = ${CACHE_SCHEMA_VERSION};
	`);
};

const configureDatabase = (database: DatabaseSync): void => {
	database.exec(`
		PRAGMA busy_timeout = 1000;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA temp_store = MEMORY;
	`);
};

const openCacheDatabase = (path: string): DatabaseSync => {
	ensurePrivateCacheTarget(path);
	let database = new DatabaseSync(path);
	try {
		configureDatabase(database);
		const userVersion = readUserVersion(database);
		if (userVersion !== 0 && userVersion !== CACHE_SCHEMA_VERSION) {
			database.close();
			removeCacheStorage(path);
			database = new DatabaseSync(path);
			configureDatabase(database);
		}
		initializeSchema(database);
		chmodSync(path, CACHE_FILE_MODE);
		return database;
	} catch (error) {
		try {
			database.close();
		} catch {}
		throw error;
	}
};

const identitiesMatch = (
	row: SessionSummaryCacheRow,
	identity: SessionSummaryFileIdentity,
): boolean =>
	row.canonical_path === identity.canonicalPath &&
	row.dev === String(identity.dev) &&
	row.ino === String(identity.ino) &&
	row.mtime_ms === identity.mtimeMs &&
	row.size === identity.size;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export class SessionSummaryCache {
	readonly path: string;
	private readonly database: DatabaseSync;
	private readonly readStatement: StatementSync;
	private readonly writeStatement: StatementSync;
	private readonly deleteStatement: StatementSync;
	private closed = false;
	private dirty = false;
	private sizeChecked = false;
	private readonly pendingWrites: PendingSummaryWrite[] = [];
	private pendingWriteBytes = 0;

	constructor(path = resolveSessionSummaryCachePath()) {
		this.path = path;
		this.database = openCacheDatabase(path);
		this.readStatement = this.database.prepare(`
			SELECT
				canonical_path, dev, ino, mtime_ms, size, parser_version,
				payload_json, issue
			FROM session_summary_cache
			WHERE source = ? AND cache_key = ?
		`);
		this.writeStatement = this.database.prepare(`
			INSERT INTO session_summary_cache (
				source, cache_key, canonical_path, dev, ino, mtime_ms, size,
				parser_version, payload_json, issue, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(source, cache_key) DO UPDATE SET
				canonical_path = excluded.canonical_path,
				dev = excluded.dev,
				ino = excluded.ino,
				mtime_ms = excluded.mtime_ms,
				size = excluded.size,
				parser_version = excluded.parser_version,
				payload_json = excluded.payload_json,
				issue = excluded.issue,
				updated_at = excluded.updated_at
		`);
		this.deleteStatement = this.database.prepare(`
			DELETE FROM session_summary_cache WHERE source = ? AND cache_key = ?
		`);
	}

	read<T>(
		source: SessionSummaryCacheSource,
		cacheKey: string,
		identity: SessionSummaryFileIdentity,
		parserVersion: number,
	): SessionSummaryCacheHit<T> | null {
		if (this.closed) {
			return null;
		}
		for (let index = this.pendingWrites.length - 1; index >= 0; index -= 1) {
			const pending = this.pendingWrites[index];
			if (pending.source !== source || pending.cacheKey !== cacheKey) {
				continue;
			}
			if (
				pending.parserVersion !== parserVersion ||
				pending.identity.canonicalPath !== identity.canonicalPath ||
				pending.identity.dev !== identity.dev ||
				pending.identity.ino !== identity.ino ||
				pending.identity.mtimeMs !== identity.mtimeMs ||
				pending.identity.size !== identity.size
			) {
				this.pendingWrites.splice(index, 1);
				this.pendingWriteBytes -= pending.byteLength;
				return null;
			}
			if (pending.issue !== null) {
				return { kind: "issue", issue: pending.issue };
			}
			if (pending.payloadJson === null) {
				return null;
			}
			try {
				const value = JSON.parse(pending.payloadJson) as unknown;
				return isJsonObject(value)
					? { kind: "value", value: value as T }
					: null;
			} catch {
				return null;
			}
		}
		try {
			const row = this.readStatement.get(source, cacheKey) as
				| SessionSummaryCacheRow
				| undefined;
			if (!row) {
				return null;
			}
			if (
				row.parser_version !== parserVersion ||
				!identitiesMatch(row, identity)
			) {
				this.deleteStatement.run(source, cacheKey);
				this.dirty = true;
				return null;
			}
			if (row.issue !== null) {
				return { kind: "issue", issue: row.issue };
			}
			if (row.payload_json === null) {
				this.deleteStatement.run(source, cacheKey);
				this.dirty = true;
				return null;
			}
			const value = JSON.parse(row.payload_json) as unknown;
			if (!isJsonObject(value)) {
				this.deleteStatement.run(source, cacheKey);
				this.dirty = true;
				return null;
			}
			return { kind: "value", value: value as T };
		} catch {
			try {
				this.deleteStatement.run(source, cacheKey);
				this.dirty = true;
			} catch {}
			return null;
		}
	}

	writeValue(
		source: SessionSummaryCacheSource,
		cacheKey: string,
		identity: SessionSummaryFileIdentity,
		parserVersion: number,
		value: object,
	): boolean {
		return this.write(
			source,
			cacheKey,
			identity,
			parserVersion,
			JSON.stringify(value),
			null,
		);
	}

	writeIssue(
		source: SessionSummaryCacheSource,
		cacheKey: string,
		identity: SessionSummaryFileIdentity,
		parserVersion: number,
		issue: string,
	): boolean {
		return this.write(source, cacheKey, identity, parserVersion, null, issue);
	}

	private write(
		source: SessionSummaryCacheSource,
		cacheKey: string,
		identity: SessionSummaryFileIdentity,
		parserVersion: number,
		payloadJson: string | null,
		issue: string | null,
	): boolean {
		if (this.closed) {
			return false;
		}
		const byteLength = Buffer.byteLength(payloadJson ?? issue ?? "", "utf8");
		this.pendingWrites.push({
			source,
			cacheKey,
			identity,
			parserVersion,
			payloadJson,
			issue,
			updatedAt: Date.now(),
			byteLength,
		});
		this.pendingWriteBytes += byteLength;
		this.dirty = true;
		if (
			this.pendingWrites.length >= WRITE_BATCH_MAX_ENTRIES ||
			this.pendingWriteBytes >= WRITE_BATCH_MAX_BYTES
		) {
			return this.flushWrites();
		}
		return true;
	}

	private flushWrites(): boolean {
		if (this.closed || this.pendingWrites.length === 0) {
			return !this.closed;
		}
		const writes = this.pendingWrites.splice(0);
		this.pendingWriteBytes = 0;
		try {
			this.database.exec("BEGIN IMMEDIATE");
			for (const pending of writes) {
				this.writeStatement.run(
					pending.source,
					pending.cacheKey,
					pending.identity.canonicalPath,
					String(pending.identity.dev),
					String(pending.identity.ino),
					pending.identity.mtimeMs,
					pending.identity.size,
					pending.parserVersion,
					pending.payloadJson,
					pending.issue,
					pending.updatedAt,
				);
			}
			this.database.exec("COMMIT");
			return true;
		} catch {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			return false;
		}
	}

	pruneSource(
		source: SessionSummaryCacheSource,
		liveCacheKeys: Iterable<string>,
	): boolean {
		if (this.closed) {
			return false;
		}
		this.flushWrites();
		try {
			this.database.exec("BEGIN IMMEDIATE");
			this.database.exec(`
				CREATE TEMP TABLE IF NOT EXISTS live_session_summary_keys (
					cache_key TEXT PRIMARY KEY
				) WITHOUT ROWID;
				DELETE FROM live_session_summary_keys;
			`);
			const insert = this.database.prepare(
				"INSERT OR IGNORE INTO live_session_summary_keys(cache_key) VALUES (?)",
			);
			for (const cacheKey of liveCacheKeys) {
				insert.run(cacheKey);
			}
			const deleteResult = this.database
				.prepare(`
					DELETE FROM session_summary_cache
					WHERE source = ?
					AND NOT EXISTS (
						SELECT 1 FROM live_session_summary_keys live
						WHERE live.cache_key = session_summary_cache.cache_key
					)
				`)
				.run(source);
			if (deleteResult.changes > 0) {
				this.dirty = true;
			}
			this.database.exec("COMMIT");
			return true;
		} catch {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			return false;
		}
	}

	maintainSize(maxBytes = SESSION_SUMMARY_CACHE_MAX_BYTES): void {
		if (this.closed || (this.sizeChecked && !this.dirty)) {
			return;
		}
		this.flushWrites();
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			let bytes = getStorageBytes(this.path);
			while (bytes > maxBytes) {
				const result = this.database
					.prepare(`
						DELETE FROM session_summary_cache
						WHERE rowid IN (
							SELECT rowid FROM session_summary_cache
							ORDER BY updated_at ASC
							LIMIT ?
						)
					`)
					.run(EVICTION_BATCH_SIZE);
				if (result.changes === 0) {
					this.database.exec("VACUUM");
					this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
					bytes = getStorageBytes(this.path);
					break;
				}
				this.database.exec("VACUUM");
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				bytes = getStorageBytes(this.path);
			}
			this.dirty = false;
			this.sizeChecked = bytes <= maxBytes;
		} catch {}
	}

	getStorageBytes(): number {
		this.flushWrites();
		return getStorageBytes(this.path);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.flushWrites();
		this.closed = true;
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {}
		try {
			this.database.close();
		} catch {}
	}
}

let defaultCache: { path: string; cache: SessionSummaryCache | null } | null =
	null;

const createCacheWithRecovery = (path: string): SessionSummaryCache | null => {
	try {
		return new SessionSummaryCache(path);
	} catch {
		removeCacheStorage(path);
		try {
			return new SessionSummaryCache(path);
		} catch {
			return null;
		}
	}
};

export const getSessionSummaryCache = (): SessionSummaryCache | null => {
	if (
		process.env.NODE_ENV === "test" &&
		!process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH
	) {
		return null;
	}
	const path = resolveSessionSummaryCachePath();
	if (defaultCache?.path === path) {
		return defaultCache.cache;
	}
	defaultCache?.cache?.close();
	defaultCache = { path, cache: createCacheWithRecovery(path) };
	return defaultCache.cache;
};

export const closeSessionSummaryCache = (): void => {
	defaultCache?.cache?.close();
	defaultCache = null;
};

export const resetSessionSummaryCacheForTesting = (): void => {
	closeSessionSummaryCache();
};

export const getSessionSummaryFileIdentity = (
	path: string,
): SessionSummaryFileIdentity | undefined => {
	try {
		const stats = statSync(path);
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(path);
		} catch {
			canonicalPath = resolve(path);
		}
		return {
			canonicalPath,
			dev: stats.dev,
			ino: stats.ino,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
		};
	} catch {
		return undefined;
	}
};
