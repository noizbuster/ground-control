import type {
	MissionControlSessionMetadata,
	Session,
	SubagentSession,
} from "../types";
import type { SessionSnapshot } from "./sessionSnapshot";

export type MissionControlSnapshotSession = Session | SubagentSession;

export interface MissionControlFallbackRow {
	readonly sessionId: string;
	readonly rawLifecycleStatus: string | null;
	readonly treeToken: string;
}

export interface MissionControlFallbackRoot {
	readonly sessionId: string;
	readonly affectedRows: readonly MissionControlFallbackRow[];
}

export interface MissionControlFallbackPlan {
	readonly parentSessionId: string;
	readonly databasePath: string;
	readonly databaseIdentity: string;
	readonly eligibleSessionIds: readonly string[];
	readonly roots: readonly MissionControlFallbackRoot[];
}

export type MissionControlFallbackPlanResult =
	| {
			readonly kind: "fallback";
			readonly plan: MissionControlFallbackPlan;
			readonly notices: readonly string[];
	  }
	| { readonly kind: "failed"; readonly error: string };

export const missionControlMetadataOf = (
	session: MissionControlSnapshotSession,
): MissionControlSessionMetadata | null =>
	session.sourceMetadata?.missionControl ?? null;

export const flattenMissionControlSnapshot = (
	snapshot: SessionSnapshot,
): MissionControlSnapshotSession[] =>
	snapshot.sessions.flatMap((root) => [root, ...(root.subagentSessions ?? [])]);

const isDescendantOf = (
	session: MissionControlSnapshotSession,
	ancestorId: string,
	sessionsById: ReadonlyMap<string, MissionControlSnapshotSession>,
): boolean => {
	const visited = new Set<string>();
	let parentId = missionControlMetadataOf(session)?.effectiveParentId ?? null;
	while (parentId !== null) {
		if (parentId === ancestorId) return true;
		if (visited.has(parentId)) return false;
		visited.add(parentId);
		const parent = sessionsById.get(parentId);
		if (!parent) return false;
		parentId = missionControlMetadataOf(parent)?.effectiveParentId ?? null;
	}
	return false;
};

export const createMissionControlFallbackPlan = (
	parentSessionId: string,
	databasePath: string,
	snapshot: SessionSnapshot,
): MissionControlFallbackPlanResult => {
	const all = flattenMissionControlSnapshot(snapshot);
	const sessionsById = new Map(all.map((session) => [session.id, session]));
	const parent = sessionsById.get(parentSessionId);
	const parentMetadata = parent ? missionControlMetadataOf(parent) : null;
	if (!parentMetadata || snapshot.sessionIssues[parentSessionId]) {
		return {
			kind: "failed",
			error:
				"Mission Control hierarchy changed or is unstable; no fallback delete was attempted.",
		};
	}
	const descendants = all.filter((session) =>
		isDescendantOf(session, parentSessionId, sessionsById),
	);
	const abortable = descendants.filter(
		(session) => missionControlMetadataOf(session)?.abortable === true,
	);
	const retryIds = abortable
		.filter(
			(session) =>
				missionControlMetadataOf(session)?.lease.fallbackSafety === "retry",
		)
		.map((session) => session.id);
	const unknownIds = abortable
		.filter(
			(session) =>
				missionControlMetadataOf(session)?.lease.fallbackSafety === "no_delete",
		)
		.map((session) => session.id);
	const eligible = abortable.filter(
		(session) =>
			missionControlMetadataOf(session)?.lease.fallbackSafety === "eligible",
	);
	const eligibleIds = new Set(eligible.map((session) => session.id));
	const minimalRoots = eligible.filter((session) => {
		let parentId = missionControlMetadataOf(session)?.effectiveParentId ?? null;
		while (parentId !== null && parentId !== parentSessionId) {
			if (eligibleIds.has(parentId)) return false;
			const parentSession = sessionsById.get(parentId);
			if (!parentSession) return false;
			parentId =
				missionControlMetadataOf(parentSession)?.effectiveParentId ?? null;
		}
		return true;
	});
	const notices: string[] = [];
	if (retryIds.length > 0)
		notices.push(`Owner still active; retry stop: ${retryIds.join(", ")}.`);
	if (unknownIds.length > 0)
		notices.push(
			`Mission Control lease state is unknown; no delete: ${unknownIds.join(", ")}.`,
		);
	const roots: MissionControlFallbackRoot[] = [];
	for (const root of minimalRoots) {
		const affected = descendants.filter(
			(session) =>
				session.id === root.id ||
				isDescendantOf(session, root.id, sessionsById),
		);
		const unsafe = affected.find((session) => {
			const metadata = missionControlMetadataOf(session);
			return (
				!metadata?.treeToken || metadata.lease.fallbackSafety !== "eligible"
			);
		});
		if (unsafe) {
			notices.push(
				`Fallback delete blocked for ${root.id}: affected session ${unsafe.id} is not lease-safe.`,
			);
			continue;
		}
		roots.push({
			sessionId: root.id,
			affectedRows: affected.map((session) => ({
				sessionId: session.id,
				rawLifecycleStatus:
					missionControlMetadataOf(session)?.rawLifecycleStatus ?? null,
				treeToken: missionControlMetadataOf(session)?.treeToken ?? "",
			})),
		});
	}
	if (roots.length === 0) {
		return {
			kind: "failed",
			error:
				notices.join(" ") || "No abortable Mission Control descendants remain.",
		};
	}
	const coveredEligibleIds = eligible
		.filter((session) =>
			roots.some((root) =>
				root.affectedRows.some((row) => row.sessionId === session.id),
			),
		)
		.map((session) => session.id);
	return {
		kind: "fallback",
		plan: {
			parentSessionId,
			databasePath,
			databaseIdentity: parentMetadata.databaseIdentity,
			eligibleSessionIds: coveredEligibleIds,
			roots,
		},
		notices,
	};
};
