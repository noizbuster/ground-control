import { type Session, SessionStatus, type SubagentSession } from "../types";

export type AbortTarget = Session | SubagentSession;

export interface AbortTargetPlan {
	/** Sessions that will receive a graceful stop (children first, then selected). */
	readonly targets: readonly AbortTarget[];
	/** Abortable child/descendant count (excludes the selected root). */
	readonly childCount: number;
	/** Whether the selected session itself is included (OpenCode/Codex stuck roots). */
	readonly includesSelected: boolean;
}

/** Statuses that still need a stop signal (not terminal). */
export const isAbortableSessionStatus = (
	status: SessionStatus | undefined,
): boolean =>
	status !== SessionStatus.completed && status !== SessionStatus.failed;

/**
 * Children/descendants that K can stop.
 * Mission Control uses the explicit `abortable` lease flag.
 * Other sources use non-terminal status (running/waiting/pending/unknown/idle).
 */
export const getAbortableChildren = (session: Session): SubagentSession[] => {
	const children = session.subagentSessions ?? [];
	if (session.sessionSource === "mission-control") {
		return children.filter(
			(child) => child.sourceMetadata?.missionControl?.abortable === true,
		);
	}
	return children.filter((child) => isAbortableSessionStatus(child.status));
};

/**
 * Full K target set for a selected root session.
 *
 * - Always includes abortable children/descendants.
 * - For OpenCode/Codex, also includes the selected root when it is non-terminal
 *   (covers unfinished compaction, zombie busy parents, and mid-stream hangs).
 * - Mission Control never stops the selected parent (existing contract).
 */
export const getAbortTargets = (session: Session): AbortTargetPlan => {
	const children = getAbortableChildren(session);

	if (session.sessionSource === "mission-control") {
		return {
			targets: children,
			childCount: children.length,
			includesSelected: false,
		};
	}

	const canStopSelected =
		(session.sessionSource === "opencode" ||
			session.sessionSource === "codex") &&
		isAbortableSessionStatus(session.status);

	if (!canStopSelected) {
		return {
			targets: children,
			childCount: children.length,
			includesSelected: false,
		};
	}

	// Prefer children first so parent stop runs after child stops settle.
	const targets: AbortTarget[] = [...children];
	if (!targets.some((target) => target.id === session.id)) {
		targets.push(session);
	}

	return {
		targets,
		childCount: children.length,
		includesSelected: true,
	};
};

export const formatAbortTargetSummary = (plan: AbortTargetPlan): string => {
	const total = plan.targets.length;
	if (total === 0) {
		return "No stuck or active sessions to stop";
	}
	if (plan.includesSelected && plan.childCount === 0) {
		return `selected session`;
	}
	if (plan.includesSelected) {
		return `${plan.childCount} child${plan.childCount === 1 ? "" : "ren"} + selected`;
	}
	return `${plan.childCount} child session${plan.childCount === 1 ? "" : "s"}`;
};
