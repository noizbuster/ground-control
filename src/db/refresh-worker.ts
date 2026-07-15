import { parentPort } from "node:worker_threads";

import {
	buildSessionSnapshot,
	mergeSessionSnapshots,
} from "../lib/sessionSnapshot";
import { getClaudeSnapshot } from "./claude";
import { getCodexSnapshot } from "./codex";
import {
	createQueryFailedDatabaseError,
	type DatabaseError,
} from "./index";
import { getMissionControlSnapshot } from "./missionControl";
import {
	getOpenCodeSnapshot,
	type OpenCodeCacheState,
	mergeOpenCodeCacheState,
	seedOpenCodeCacheState,
} from "./opencode";
import { getOmpSnapshot, getPiSnapshot } from "./pi";
import {
	createErrorResponse,
	createSuccessResponse,
	isRefreshRequest,
	type RefreshRequest,
	type RefreshResponse,
} from "./refresh-worker-protocol";
import { getWaitingSignalCandidateIds } from "./waitingSignalCandidates";

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
// refresh reads only sessions whose time_updated advanced, merges that delta,
// and drops any id missing from the live active set (hard deletes + archives).
// The snapshot is rebuilt from the merged cache so the main thread still
// receives a complete RefreshSnapshotPayload every refresh. Other sources
// stay full reads.
let openCodeCache: OpenCodeCacheState | null = null;

const resetOpenCodeCache = (): void => {
	openCodeCache = null;
};

const buildOpenCodeSnapshotFromCache = (cache: OpenCodeCacheState) => {
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

	const nonTerminalSessionIds = openCodeCache
		? getWaitingSignalCandidateIds(
				[...openCodeCache.rawSessionsById.keys()],
				openCodeCache.latestMessages,
			)
		: [];

	const openCodeResult = getOpenCodeSnapshot({
		since: openCodeCache ? openCodeCache.lastRefreshTime : undefined,
		nonTerminalSessionIds,
	});

	if (openCodeResult.ok) {
		openCodeCache = openCodeCache
			? mergeOpenCodeCacheState(openCodeCache, openCodeResult.value)
			: seedOpenCodeCacheState(openCodeResult.value);
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
		{ source: "Mission Control", result: getMissionControlSnapshot() },
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
