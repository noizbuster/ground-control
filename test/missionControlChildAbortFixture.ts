import type { SessionSnapshot } from "../src/lib/sessionSnapshot";
import {
	type Session,
	SessionStatus,
	type SubagentSession,
} from "../src/types";

export const DATABASE_PATH = "/selected/mc/mission-control.db";
const DATABASE_IDENTITY = "d".repeat(64);

export const mcSession = (params: {
	id: string;
	parentId: string | null;
	abortable: boolean;
	lease: "eligible" | "retry" | "no_delete";
	token?: string;
	rawStatus?: string;
}): SubagentSession => ({
	id: params.id,
	title: params.id,
	directory: "/repo",
	project_id: "project",
	project_label: "project",
	parent_id: params.parentId,
	time_created: 1,
	time_updated: 1,
	sessionSource: "mission-control",
	status: SessionStatus.running,
	sourceMetadata: {
		missionControl: {
			databaseIdentity: DATABASE_IDENTITY,
			canonicalDatabasePath: DATABASE_PATH,
			rawLifecycleStatus: params.rawStatus ?? "running",
			hasActiveWork: false,
			abortable: params.abortable,
			lease: {
				state:
					params.lease === "retry"
						? "live"
						: params.lease === "eligible"
							? "expired"
							: "unknown",
				fallbackSafety: params.lease,
			},
			effectiveParentId: params.parentId,
			treeToken: params.token ?? params.id.padEnd(64, "0").slice(0, 64),
		},
	},
});

export const snapshot = (
	children: SubagentSession[],
	issues: SessionSnapshot["sessionIssues"] = {},
): SessionSnapshot => {
	const root = mcSession({
		id: "parent",
		parentId: null,
		abortable: true,
		lease: "eligible",
	});
	return {
		sessions: [{ ...root, subagentSessions: children } as Session],
		statusBySessionId: {},
		messageCountBySessionId: {},
		sessionIssues: issues,
		sourceIssues: [],
	};
};

export const selectedParent = (children: SubagentSession[]): Session => ({
	...mcSession({
		id: "parent",
		parentId: null,
		abortable: true,
		lease: "eligible",
	}),
	subagentSessions: children,
});
