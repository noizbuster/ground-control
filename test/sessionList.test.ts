import { describe, expect, it } from "vitest";
import { getExternalAttachedDirectoryKey } from "../src/lib/attachedSessionSignals";
import {
	applySessionFilter,
	applySessionSort,
	isAttachedPinCandidateSession,
	normalizeDirectoryPath,
	selectDirectoryPinnedSessionIds,
} from "../src/lib/sessionList";
import { type Session, SessionStatus } from "../src/types";

const createSession = (params: {
	id: string;
	status: SessionStatus;
	timeUpdated: number;
	timeCreated?: number;
	directory?: string;
	finishReason?: string;
	sessionSource?: Session["sessionSource"];
}): Session => ({
	id: params.id,
	title: params.id,
	directory: params.directory ?? "/repo/app",
	project_id: params.directory ?? "/repo/app",
	project_label: "app",
	parent_id: null,
	time_created: params.timeCreated ?? params.timeUpdated - 1,
	time_updated: params.timeUpdated,
	sessionSource: params.sessionSource ?? "omp",
	status: params.status,
	finishReason: params.finishReason,
});

const getDirectoryKey = (session: Session): string =>
	getExternalAttachedDirectoryKey(
		session.sessionSource,
		normalizeDirectoryPath(session.directory),
	);

describe("attached directory pin candidates", () => {
	it("treats idle as a pin candidate alongside completed", () => {
		const idle = createSession({
			id: "idle",
			status: SessionStatus.idle,
			timeUpdated: 10,
		});
		const completed = createSession({
			id: "completed",
			status: SessionStatus.completed,
			timeUpdated: 20,
		});
		const running = createSession({
			id: "running",
			status: SessionStatus.running,
			timeUpdated: 30,
		});

		expect(isAttachedPinCandidateSession(idle)).toBe(true);
		expect(isAttachedPinCandidateSession(completed)).toBe(true);
		expect(isAttachedPinCandidateSession(running)).toBe(false);
	});

	it("pins the newest idle session for remaining process slots", () => {
		const olderIdle = createSession({
			id: "idle-old",
			status: SessionStatus.idle,
			timeUpdated: 10,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const newerIdle = createSession({
			id: "idle-new",
			status: SessionStatus.idle,
			timeUpdated: 40,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const completed = createSession({
			id: "completed",
			status: SessionStatus.completed,
			timeUpdated: 20,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const directoryKey = getDirectoryKey(newerIdle);

		const pinned = selectDirectoryPinnedSessionIds({
			sessions: [olderIdle, newerIdle, completed],
			directoryProcessCounts: new Map([[directoryKey, 1]]),
			getDirectoryKey,
		});

		expect([...pinned]).toEqual(["idle-new"]);

		const filtered = applySessionFilter(
			[olderIdle, newerIdle, completed],
			"active",
			pinned,
		);
		expect(filtered.sessions.map((session) => session.id)).toEqual([
			"idle-new",
		]);
	});

	it("pins one settled Mission Control session per live process slot", () => {
		const sessions = [
			createSession({
				id: "idle-old",
				status: SessionStatus.idle,
				timeUpdated: 10,
				sessionSource: "mission-control",
				directory: "/repo/mc",
			}),
			createSession({
				id: "completed-newer",
				status: SessionStatus.completed,
				timeUpdated: 20,
				sessionSource: "mission-control",
				directory: "/repo/mc",
			}),
			createSession({
				id: "idle-latest",
				status: SessionStatus.idle,
				timeUpdated: 30,
				sessionSource: "mission-control",
				directory: "/repo/mc",
			}),
		];
		const directoryKey = getDirectoryKey(sessions[0]);

		const pinned = selectDirectoryPinnedSessionIds({
			sessions,
			directoryProcessCounts: new Map([[directoryKey, 2]]),
			getDirectoryKey,
		});

		expect([...pinned]).toEqual(["idle-latest", "completed-newer"]);
		expect(
			applySessionFilter(sessions, "active", pinned).sessions.map(
				(session) => session.id,
			),
		).toEqual(["idle-latest", "completed-newer"]);
	});

	it("does not let idle sessions consume process slots meant for pins", () => {
		const idle = createSession({
			id: "idle",
			status: SessionStatus.idle,
			timeUpdated: 50,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const completed = createSession({
			id: "completed",
			status: SessionStatus.completed,
			timeUpdated: 10,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const directoryKey = getDirectoryKey(idle);

		// One process, one idle, one older completed → pin newest candidate (idle).
		const pinned = selectDirectoryPinnedSessionIds({
			sessions: [idle, completed],
			directoryProcessCounts: new Map([[directoryKey, 1]]),
			getDirectoryKey,
		});

		expect([...pinned]).toEqual(["idle"]);
	});

	it("subtracts active work from process slots before pinning idle/completed", () => {
		const running = createSession({
			id: "running",
			status: SessionStatus.running,
			timeUpdated: 30,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const idle = createSession({
			id: "idle",
			status: SessionStatus.idle,
			timeUpdated: 40,
			sessionSource: "mission-control",
			directory: "/repo/mc",
		});
		const directoryKey = getDirectoryKey(idle);

		// One process already matched by running work → no spare pin slot.
		const pinned = selectDirectoryPinnedSessionIds({
			sessions: [running, idle],
			directoryProcessCounts: new Map([[directoryKey, 1]]),
			getDirectoryKey,
		});

		expect([...pinned]).toEqual([]);
	});
});

describe("session list filtering", () => {
	it("keeps pinned completed sessions visible without changing their status", () => {
		const running = createSession({
			id: "running",
			status: SessionStatus.running,
			timeUpdated: 10,
		});
		const pinnedCompleted = createSession({
			id: "pinned-completed",
			status: SessionStatus.completed,
			timeUpdated: 30,
		});
		const hiddenCompleted = createSession({
			id: "hidden-completed",
			status: SessionStatus.completed,
			timeUpdated: 20,
		});

		const filtered = applySessionFilter(
			[running, pinnedCompleted, hiddenCompleted],
			"active",
			new Set(["pinned-completed"]),
		);
		const sorted = applySessionSort(filtered.sessions, "status");

		expect(filtered.hiddenCompletedCount).toBe(1);
		expect(sorted.map((session) => [session.id, session.status])).toEqual([
			["running", SessionStatus.running],
			["pinned-completed", SessionStatus.completed],
		]);
	});

	it("hides interrupted sessions in active mode unless pinned", () => {
		const running = createSession({
			id: "running",
			status: SessionStatus.running,
			timeUpdated: 40,
		});
		const interrupted = createSession({
			id: "interrupted",
			status: SessionStatus.unknown,
			timeUpdated: 50,
			finishReason: "interrupted",
		});
		const pinnedInterrupted = createSession({
			id: "pinned-interrupted",
			status: SessionStatus.unknown,
			timeUpdated: 60,
			finishReason: "turn_aborted",
		});

		const filtered = applySessionFilter(
			[running, interrupted, pinnedInterrupted],
			"active",
			new Set(["pinned-interrupted"]),
		);

		expect(filtered.hiddenCompletedCount).toBe(1);
		expect(filtered.sessions.map((session) => session.id).sort()).toEqual([
			"pinned-interrupted",
			"running",
		]);
	});

	it("excludes interrupted sessions from busy mode", () => {
		const running = createSession({
			id: "running",
			status: SessionStatus.running,
			timeUpdated: 10,
		});
		const interrupted = createSession({
			id: "interrupted",
			status: SessionStatus.unknown,
			timeUpdated: 20,
			finishReason: "interrupted",
		});

		const filtered = applySessionFilter([running, interrupted], "busy");

		expect(filtered.sessions.map((session) => session.id)).toEqual(["running"]);
	});
});

describe("session list sorting", () => {
	it("orders status groups by creation date before update date", () => {
		const oldestRunning = createSession({
			id: "running-oldest-created",
			status: SessionStatus.running,
			timeCreated: 10,
			timeUpdated: 300,
		});
		const middleRunning = createSession({
			id: "running-middle-created",
			status: SessionStatus.running,
			timeCreated: 20,
			timeUpdated: 200,
		});
		const newestRunning = createSession({
			id: "running-newest-created",
			status: SessionStatus.running,
			timeCreated: 30,
			timeUpdated: 100,
		});
		const newestCompleted = createSession({
			id: "completed-newest-created",
			status: SessionStatus.completed,
			timeCreated: 40,
			timeUpdated: 400,
		});

		const sorted = applySessionSort(
			[middleRunning, newestCompleted, oldestRunning, newestRunning],
			"status",
		);

		expect(sorted.map((session) => session.id)).toEqual([
			"running-newest-created",
			"running-middle-created",
			"running-oldest-created",
			"completed-newest-created",
		]);
	});
});
