import { parentPort } from "node:worker_threads";

import {
	buildSessionSnapshot,
	mergeSessionSnapshots,
} from "../lib/sessionSnapshot";
import type { SessionRecord } from "../types";
import { getClaudeSnapshot } from "./claude";
import { getCodexSnapshot } from "./codex";
import {
	createQueryFailedDatabaseError,
	type DatabaseError,
	type LatestMessageResultsBySessionId,
	type MessageCountsBySessionId,
	type WaitingSignalsBySessionId,
} from "./index";
import { getOpenCodeSnapshot, type OpenCodeReadResult } from "./opencode";
import { getOmpSnapshot, getPiSnapshot } from "./pi";
import {
	createErrorResponse,
	createSuccessResponse,
	isRefreshRequest,
	type RefreshRequest,
	type RefreshResponse,
} from "./refresh-worker-protocol";

if (!parentPort) {
	throw new Error("refresh-worker must be run as a Worker thread");
}

const port = parentPort;

const pendingRequests: RefreshRequest[] = [];
let isProcessing = false;

const formatSourceIssue = (source: string, error: DatabaseError): string => {
	return `${source}: ${error.message}`;
};

// Incremental OpenCode cache. The first refresh does a full read; each later
// refresh reads only sessions whose time_updated advanced (plus ids of newly
// archived sessions) and merges the delta here. The snapshot is then rebuilt
// from the merged cache, so the main thread still receives a complete
// RefreshSnapshotPayload every refresh. Other sources stay full reads.
interface OpenCodeCache {
	rawSessionsById: Map<string, SessionRecord>;
	latestMessages: LatestMessageResultsBySessionId;
	messageCounts: MessageCountsBySessionId;
	waitingSignals: WaitingSignalsBySessionId;
	lastRefreshTime: number;
}

let openCodeCache: OpenCodeCache | null = null;

const resetOpenCodeCache = (): void => {
	openCodeCache = null;
};

const seedOpenCodeCache = (result: OpenCodeReadResult): OpenCodeCache => {
	const rawSessionsById = new Map<string, SessionRecord>();
	for (const session of result.rawSessions) {
		rawSessionsById.set(session.id, session);
	}
	return {
		rawSessionsById,
		latestMessages: { ...result.latestMessages },
		messageCounts: { ...result.messageCounts },
		waitingSignals: { ...result.waitingSignals },
		lastRefreshTime: result.maxUpdatedAt,
	};
};

const mergeOpenCodeDelta = (
	cache: OpenCodeCache,
	result: OpenCodeReadResult,
): OpenCodeCache => {
	if (result.changed) {
		for (const session of result.rawSessions) {
			cache.rawSessionsById.set(session.id, session);
		}
		for (const removedId of result.removedSessionIds) {
			cache.rawSessionsById.delete(removedId);
			delete cache.latestMessages[removedId];
			delete cache.messageCounts[removedId];
			delete cache.waitingSignals[removedId];
		}
		for (const [id, message] of Object.entries(result.latestMessages)) {
			cache.latestMessages[id] = message;
		}
		for (const [id, count] of Object.entries(result.messageCounts)) {
			cache.messageCounts[id] = count;
		}
		for (const [id, signal] of Object.entries(result.waitingSignals)) {
			cache.waitingSignals[id] = signal;
		}
	}
	cache.lastRefreshTime = result.maxUpdatedAt;
	return cache;
};

const buildOpenCodeSnapshotFromCache = (cache: OpenCodeCache) => {
	const rawSessions = [...cache.rawSessionsById.values()].sort(
		(left, right) => right.time_updated - left.time_updated,
	);
	return buildSessionSnapshot({
		rawSessions,
		latestMessages: cache.latestMessages,
		messageCounts: cache.messageCounts,
		waitingSignals: cache.waitingSignals,
	});
};

const buildResponse = (request: RefreshRequest): RefreshResponse => {
	const snapshots = [];
	const sourceIssues: string[] = [];

	const openCodeResult = getOpenCodeSnapshot({
		since: openCodeCache ? openCodeCache.lastRefreshTime : undefined,
	});

	if (openCodeResult.ok) {
		openCodeCache = openCodeCache
			? mergeOpenCodeDelta(openCodeCache, openCodeResult.value)
			: seedOpenCodeCache(openCodeResult.value);
		snapshots.push(buildOpenCodeSnapshotFromCache(openCodeCache));
	} else {
		// DB error (or stale-handle reopen): drop the cache so the next refresh
		// is a full read instead of an incremental read against a stale marker.
		resetOpenCodeCache();
		sourceIssues.push(formatSourceIssue("OpenCode", openCodeResult.error));
	}

	const otherResults = [
		{ source: "Codex", result: getCodexSnapshot() },
		{ source: "Claude Code", result: getClaudeSnapshot() },
		{ source: "Pi", result: getPiSnapshot() },
		{ source: "omp", result: getOmpSnapshot() },
	] as const;

	for (const { source, result } of otherResults) {
		if (result.ok) {
			snapshots.push(result.value);
			continue;
		}

		sourceIssues.push(formatSourceIssue(source, result.error));
	}

	if (snapshots.length === 0) {
		return createErrorResponse(
			request.requestId,
			createQueryFailedDatabaseError(
				new Error(sourceIssues.join(" | ")),
				"No session sources are currently readable.",
			),
		);
	}

	return createSuccessResponse(
		request.requestId,
		mergeSessionSnapshots(snapshots, sourceIssues),
	);
};

const processNextRequest = (): void => {
	if (isProcessing) {
		return;
	}

	const request = pendingRequests.shift();
	if (!request) {
		return;
	}

	isProcessing = true;

	try {
		const response = buildResponse(request);
		port.postMessage(response);
	} finally {
		isProcessing = false;
		if (pendingRequests.length > 0) {
			processNextRequest();
		}
	}
};

port.on("message", (data: unknown) => {
	if (!isRefreshRequest(data)) {
		return;
	}

	pendingRequests.push(data);
	processNextRequest();
});
