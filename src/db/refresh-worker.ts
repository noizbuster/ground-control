import { mergeSessionSnapshots } from "../lib/sessionSnapshot";
import { getClaudeSnapshot } from "./claude";
import { getCodexSnapshot } from "./codex";
import { createQueryFailedDatabaseError, type DatabaseError } from "./index";
import { getOpenCodeSnapshot } from "./opencode";
import {
	createErrorResponse,
	createSuccessResponse,
	isRefreshRequest,
	type RefreshRequest,
	type RefreshResponse,
} from "./refresh-worker-protocol";

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(response: RefreshResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;
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
		workerScope.postMessage(response);
	} finally {
		isProcessing = false;
		if (pendingRequests.length > 0) {
			processNextRequest();
		}
	}
};

workerScope.onmessage = (event) => {
	if (!isRefreshRequest(event.data)) {
		return;
	}

	pendingRequests.push(event.data);
	processNextRequest();
};
