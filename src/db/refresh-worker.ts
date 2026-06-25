import { parentPort } from "node:worker_threads";

import { mergeSessionSnapshots } from "../lib/sessionSnapshot";
import { getClaudeSnapshot } from "./claude";
import { getCodexSnapshot } from "./codex";
import { createQueryFailedDatabaseError, type DatabaseError } from "./index";
import { getOpenCodeSnapshot } from "./opencode";
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

const buildResponse = (request: RefreshRequest): RefreshResponse => {
	const snapshots = [];
	const sourceIssues: string[] = [];
	const results = [
		{ source: "OpenCode", result: getOpenCodeSnapshot() },
		{ source: "Codex", result: getCodexSnapshot() },
		{ source: "Claude Code", result: getClaudeSnapshot() },
		{ source: "Pi", result: getPiSnapshot() },
		{ source: "omp", result: getOmpSnapshot() },
	] as const;

	for (const { source, result } of results) {
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
