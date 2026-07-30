import { describe, expect, test } from "vitest";
import {
	formatAbortTargetSummary,
	getAbortableChildren,
	getAbortTargets,
	isAbortableSessionStatus,
} from "../src/lib/abortTargets";
import {
	type Session,
	SessionStatus,
	type SubagentSession,
} from "../src/types";

const baseSession = (
	overrides: Partial<Session> & Pick<Session, "id">,
): Session => ({
	project_id: "proj",
	title: "root",
	directory: "/tmp",
	project_label: "tmp",
	parent_id: null,
	time_created: 1,
	time_updated: 2,
	sessionSource: "opencode",
	status: SessionStatus.completed,
	...overrides,
});

const child = (
	overrides: Partial<SubagentSession> & Pick<SubagentSession, "id">,
): SubagentSession => ({
	project_id: "proj",
	title: "child",
	directory: "/tmp",
	project_label: "tmp",
	parent_id: "root",
	time_created: 1,
	time_updated: 2,
	sessionSource: "opencode",
	status: SessionStatus.running,
	...overrides,
});

describe("isAbortableSessionStatus", () => {
	test("treats completed and failed as terminal", () => {
		expect(isAbortableSessionStatus(SessionStatus.completed)).toBe(false);
		expect(isAbortableSessionStatus(SessionStatus.failed)).toBe(false);
	});

	test("treats non-terminal statuses as abortable", () => {
		expect(isAbortableSessionStatus(SessionStatus.running)).toBe(true);
		expect(isAbortableSessionStatus(SessionStatus.waiting)).toBe(true);
		expect(isAbortableSessionStatus(SessionStatus.pending)).toBe(true);
		expect(isAbortableSessionStatus(SessionStatus.unknown)).toBe(true);
		expect(isAbortableSessionStatus(SessionStatus.idle)).toBe(true);
		expect(isAbortableSessionStatus(undefined)).toBe(true);
	});
});

describe("getAbortableChildren", () => {
	test("filters non-terminal children for opencode", () => {
		const session = baseSession({
			id: "root",
			subagentSessions: [
				child({ id: "a", status: SessionStatus.running }),
				child({ id: "b", status: SessionStatus.completed }),
				child({ id: "c", status: SessionStatus.failed }),
				child({ id: "d", status: SessionStatus.waiting }),
			],
		});
		expect(getAbortableChildren(session).map((c) => c.id)).toEqual(["a", "d"]);
	});

	test("uses mission-control abortable flag", () => {
		const session = baseSession({
			id: "root",
			sessionSource: "mission-control",
			subagentSessions: [
				child({
					id: "live",
					sessionSource: "mission-control",
					status: SessionStatus.running,
					sourceMetadata: {
						missionControl: {
							databaseIdentity: "db",
							canonicalDatabasePath: "/tmp/mc.db",
							rawLifecycleStatus: "running",
							hasActiveWork: true,
							abortable: true,
							lease: { state: "live", fallbackSafety: "retry" },
						},
					},
				}),
				child({
					id: "blocked",
					sessionSource: "mission-control",
					status: SessionStatus.running,
					sourceMetadata: {
						missionControl: {
							databaseIdentity: "db",
							canonicalDatabasePath: "/tmp/mc.db",
							rawLifecycleStatus: "running",
							hasActiveWork: true,
							abortable: false,
							lease: { state: "live", fallbackSafety: "no_delete" },
						},
					},
				}),
			],
		});
		expect(getAbortableChildren(session).map((c) => c.id)).toEqual(["live"]);
	});
});

describe("getAbortTargets", () => {
	test("opencode includes stuck selected root plus running children", () => {
		const session = baseSession({
			id: "root",
			status: SessionStatus.running,
			subagentSessions: [
				child({ id: "child-run", status: SessionStatus.running }),
				child({ id: "child-done", status: SessionStatus.completed }),
			],
		});
		const plan = getAbortTargets(session);
		expect(plan.childCount).toBe(1);
		expect(plan.includesSelected).toBe(true);
		expect(plan.targets.map((t) => t.id)).toEqual(["child-run", "root"]);
	});

	test("opencode with only stuck root still targets selected", () => {
		const session = baseSession({
			id: "root",
			status: SessionStatus.running,
			subagentSessions: [
				child({ id: "done", status: SessionStatus.completed }),
			],
		});
		const plan = getAbortTargets(session);
		expect(plan.targets.map((t) => t.id)).toEqual(["root"]);
		expect(plan.includesSelected).toBe(true);
		expect(formatAbortTargetSummary(plan)).toBe("selected session");
	});

	test("completed opencode root only targets children", () => {
		const session = baseSession({
			id: "root",
			status: SessionStatus.completed,
			subagentSessions: [
				child({ id: "stuck", status: SessionStatus.running }),
			],
		});
		const plan = getAbortTargets(session);
		expect(plan.includesSelected).toBe(false);
		expect(plan.targets.map((t) => t.id)).toEqual(["stuck"]);
		expect(formatAbortTargetSummary(plan)).toBe("1 child session");
	});

	test("mission-control never includes selected parent", () => {
		const session = baseSession({
			id: "root",
			sessionSource: "mission-control",
			status: SessionStatus.running,
			subagentSessions: [
				child({
					id: "mc-child",
					sessionSource: "mission-control",
					status: SessionStatus.running,
					sourceMetadata: {
						missionControl: {
							databaseIdentity: "db",
							canonicalDatabasePath: "/tmp/mc.db",
							rawLifecycleStatus: "running",
							hasActiveWork: true,
							abortable: true,
							lease: { state: "missing", fallbackSafety: "eligible" },
						},
					},
				}),
			],
		});
		const plan = getAbortTargets(session);
		expect(plan.includesSelected).toBe(false);
		expect(plan.targets.map((t) => t.id)).toEqual(["mc-child"]);
	});

	test("OMP targets every non-terminal flattened descendant but not its root", () => {
		const session = baseSession({
			id: "omp-root",
			sessionSource: "omp",
			status: SessionStatus.running,
			subagentSessions: [
				child({
					id: "omp-child",
					sessionSource: "omp",
					status: SessionStatus.running,
				}),
				child({
					id: "omp-grandchild",
					sessionSource: "omp",
					parent_id: "omp-child",
					status: SessionStatus.waiting,
				}),
				child({
					id: "omp-stopped",
					sessionSource: "omp",
					status: SessionStatus.completed,
				}),
			],
		});

		const plan = getAbortTargets(session);
		expect(plan.childCount).toBe(2);
		expect(plan.includesSelected).toBe(false);
		expect(plan.targets.map((target) => target.id)).toEqual([
			"omp-child",
			"omp-grandchild",
		]);
	});

	test("codex includes selected when non-terminal", () => {
		const session = baseSession({
			id: "codex-root",
			sessionSource: "codex",
			status: SessionStatus.waiting,
			subagentSessions: [],
		});
		const plan = getAbortTargets(session);
		expect(plan.includesSelected).toBe(true);
		expect(plan.targets.map((t) => t.id)).toEqual(["codex-root"]);
	});
});
