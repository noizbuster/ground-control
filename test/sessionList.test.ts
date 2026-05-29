import { describe, expect, it } from "bun:test";
import { applySessionFilter, applySessionSort } from "../src/lib/sessionList";
import { type Session, SessionStatus } from "../src/types";

const createSession = (params: {
	id: string;
	status: SessionStatus;
	timeUpdated: number;
	directory?: string;
}): Session => ({
	id: params.id,
	title: params.id,
	directory: params.directory ?? "/repo/app",
	project_id: params.directory ?? "/repo/app",
	project_label: "app",
	parent_id: null,
	time_created: params.timeUpdated - 1,
	time_updated: params.timeUpdated,
	sessionSource: "omp",
	status: params.status,
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
});
