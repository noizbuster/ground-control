import { describe, expect, it } from "vitest";
import type { RefreshSnapshotPayload } from "../src/db/refresh-worker-protocol";
import { createRefreshRenderSignature } from "../src/lib/refreshRenderSignature";
import { type Session, SessionStatus } from "../src/types";

const createSession = (overrides: Partial<Session> = {}): Session => ({
	id: "session-1",
	title: "Session 1",
	directory: "/repo/app",
	project_id: "project-1",
	project_label: "Project 1",
	parent_id: null,
	time_created: 1_700_000_000_000,
	time_updated: 1_700_000_001_000,
	sessionSource: "opencode",
	status: SessionStatus.running,
	subagentSessions: [],
	...overrides,
});

const createSnapshot = (
	sessionOverrides: Partial<Session> = {},
): RefreshSnapshotPayload => {
	const session = createSession(sessionOverrides);

	return {
		sessions: [session],
		statusBySessionId: { [session.id]: session.status },
		messageCountBySessionId: { [session.id]: 2 },
		sessionIssues: {},
		sourceIssues: [],
	};
};

describe("createRefreshRenderSignature", () => {
	it("stays stable for equivalent refresh payloads", () => {
		const left = createRefreshRenderSignature({
			snapshot: createSnapshot(),
			sessionFilterMode: "active",
			sessionSortMode: "status",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(["session-1"]),
			externalAttachedSessionDirectoryCounts: new Map([
				["opencode:/repo/app", 1],
			]),
		});
		const right = createRefreshRenderSignature({
			snapshot: createSnapshot(),
			sessionFilterMode: "active",
			sessionSortMode: "status",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(["session-1"]),
			externalAttachedSessionDirectoryCounts: new Map([
				["opencode:/repo/app", 1],
			]),
		});

		expect(right).toBe(left);
	});

	it("changes when visible refresh state changes", () => {
		const before = createRefreshRenderSignature({
			snapshot: createSnapshot(),
			sessionFilterMode: "active",
			sessionSortMode: "status",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(),
			externalAttachedSessionDirectoryCounts: new Map(),
		});
		const after = createRefreshRenderSignature({
			snapshot: createSnapshot({ status: SessionStatus.waiting }),
			sessionFilterMode: "active",
			sessionSortMode: "status",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(),
			externalAttachedSessionDirectoryCounts: new Map(),
		});

		expect(after).not.toBe(before);
	});

	it("changes when refresh-affecting view inputs change", () => {
		const before = createRefreshRenderSignature({
			snapshot: createSnapshot(),
			sessionFilterMode: "active",
			sessionSortMode: "status",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(),
			externalAttachedSessionDirectoryCounts: new Map(),
		});
		const after = createRefreshRenderSignature({
			snapshot: createSnapshot(),
			sessionFilterMode: "recent",
			sessionSortMode: "update",
			selectedSessionId: "session-1",
			externalAttachedSessionIds: new Set(["session-1"]),
			externalAttachedSessionDirectoryCounts: new Map([
				["opencode:/repo/app", 1],
			]),
		});

		expect(after).not.toBe(before);
	});
});
