import { DatabaseSync } from "node:sqlite";
import type { SessionSnapshot } from "../lib/sessionSnapshot";
import {
	getDefaultSessionCapabilities,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import type { MissionControlSessionMetadata, Session } from "../types";
import {
	createQueryFailedDatabaseError,
	type DatabaseError,
	type DatabaseResult,
} from "./index";
import {
	getProjectLabel,
	normalizeTimestampMs,
	truncateTitle,
} from "./missionControlHelpers";
import { resolveMissionControlDatabaseIdentity } from "./missionControlSqlite";
import {
	fetchEventMetadataFallbacks,
	type McMetadataFallbacksBySession,
} from "./missionControlSqliteEvents";
import { assembleSqliteHierarchy } from "./missionControlSqliteHierarchy";
import {
	readMcMessageCounts,
	readMcRelations,
	readMcSqliteSessionRows,
} from "./missionControlSqliteRows";
import { readMissionControlRuntimeMetadata } from "./missionControlSqliteRuntime";
import { mapMissionControlSessionStatus } from "./missionControlSqliteStatus";

const SESSIONS_TABLE_LOOKUP_QUERY =
	"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'";

const emptyFallbacks = (): McMetadataFallbacksBySession => ({
	directory: new Map<string, string>(),
	title: new Map<string, string>(),
	model: new Map(),
});

const safeFetchEventFallbacks = (
	database: DatabaseSync,
	sessionIds: readonly string[],
): McMetadataFallbacksBySession => {
	try {
		return fetchEventMetadataFallbacks(database, sessionIds);
	} catch {
		return emptyFallbacks();
	}
};

const lifecycleReason = (
	metadata: MissionControlSessionMetadata,
): string | undefined => metadata.lifecycleReason;

const isMissingDatabaseError = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	const code = "code" in error ? error.code : undefined;
	return (
		code === "ENOENT" ||
		message.includes("unable to open database file") ||
		message.includes("no such file or directory")
	);
};

const missingDatabase = (
	databasePath: string,
): DatabaseResult<SessionSnapshot> => ({
	ok: false,
	error: {
		code: "missing_database",
		message: `${getSessionSourceLabel("mission-control")} database not found at ${databasePath}.`,
	} satisfies DatabaseError,
});

export const getMissionControlSnapshotFromSqlite = (params: {
	databasePath: string;
	nowWallMs?: number;
}): DatabaseResult<SessionSnapshot> => {
	const { databasePath } = params;
	let database: DatabaseSync | null = null;
	try {
		database = new DatabaseSync(databasePath, { readOnly: true });
		if (database.prepare(SESSIONS_TABLE_LOOKUP_QUERY).get() === undefined) {
			return missingDatabase(databasePath);
		}
		const sessionRows = readMcSqliteSessionRows(database);
		const messageCounts = readMcMessageCounts(database);
		const identity = resolveMissionControlDatabaseIdentity(databasePath);
		const runtimeMetadata = readMissionControlRuntimeMetadata({
			database,
			sessions: sessionRows,
			dbIdentity: identity.dbIdentity,
			canonicalDatabasePath: identity.databasePath,
			nowWallMs: params.nowWallMs ?? Date.now(),
		});
		const fallbackIds = sessionRows
			.filter(
				(row) =>
					!row.workspacePath || !row.title || !row.modelId || !row.providerId,
			)
			.map((row) => row.sessionId);
		const fallbacks = safeFetchEventFallbacks(database, fallbackIds);
		const flatSessions: Session[] = [];
		const statusBySessionId: SessionSnapshot["statusBySessionId"] = {};
		const messageCountBySessionId: SessionSnapshot["messageCountBySessionId"] =
			{};
		for (const row of sessionRows) {
			const runtime = runtimeMetadata.get(row.sessionId);
			if (runtime === undefined) continue;
			const mapped = mapMissionControlSessionStatus(
				row.status,
				row.waitReason ?? row.awaitingReason,
				lifecycleReason(runtime),
			);
			const directory =
				row.workspacePath ?? fallbacks.directory.get(row.sessionId) ?? "";
			const titleSource = row.title ?? fallbacks.title.get(row.sessionId);
			const modelFallback = fallbacks.model.get(row.sessionId);
			const timeCreated = normalizeTimestampMs(row.createdAt) ?? 0;
			const timeUpdated =
				normalizeTimestampMs(row.lastActivityAt) ??
				normalizeTimestampMs(row.updatedAt) ??
				timeCreated;
			flatSessions.push({
				id: row.sessionId,
				title: titleSource ? truncateTitle(titleSource) : row.sessionId,
				directory,
				project_id: row.sessionId,
				project_label: getProjectLabel(directory),
				parent_id: row.parentSessionId,
				time_created: timeCreated,
				time_updated: timeUpdated,
				sessionSource: "mission-control",
				capabilities: getDefaultSessionCapabilities("mission-control"),
				currentModelID: row.modelId ?? modelFallback?.currentModelID,
				providerID: row.providerId ?? modelFallback?.providerID,
				status: mapped.status,
				statusDetail: mapped.statusDetail,
				sourceMetadata: {
					sessionPath: databasePath,
					rawSource: databasePath,
					missionControl: runtime,
				},
				subagentSessions: [],
			});
			statusBySessionId[row.sessionId] = mapped.status;
			messageCountBySessionId[row.sessionId] =
				messageCounts.get(row.sessionId) ?? 0;
		}
		const assembled = assembleSqliteHierarchy({
			flatSessions,
			relations: readMcRelations(database),
			statusBySessionId,
			sourceLabel: getSessionSourceLabel("mission-control"),
		});
		return {
			ok: true,
			value: {
				sessions: assembled.sessions,
				statusBySessionId: assembled.statusBySessionId,
				messageCountBySessionId,
				sessionIssues: assembled.sessionIssues,
				sourceIssues: [],
			},
		};
	} catch (error) {
		if (isMissingDatabaseError(error)) return missingDatabase(databasePath);
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Failed to read Mission Control SQLite sessions.",
			),
		};
	} finally {
		try {
			database?.close();
		} catch {}
	}
};
