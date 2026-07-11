import type { DatabaseResult } from "../db";
import {
	deleteMissionControlSession,
	type MissionControlDeleteResult,
	stopMissionControlChildren,
} from "../db/missionControl";
import { getMissionControlSnapshotFromSqlite } from "../db/missionControlSqliteSnapshot";
import type { Session } from "../types";
import {
	createMissionControlFallbackPlan,
	flattenMissionControlSnapshot,
	type MissionControlFallbackPlan,
	missionControlMetadataOf,
} from "./missionControlFallbackPlan";
import type { SessionSnapshot } from "./sessionSnapshot";

type MaybePromise<T> = T | Promise<T>;

export type { MissionControlFallbackPlan } from "./missionControlFallbackPlan";

interface ChildAbortDependencies {
	readonly refreshAfterStop: () => Promise<void>;
	readonly stopChildren?: (
		parentSessionId: string,
		databasePath: string,
	) => Promise<{
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
	}>;
	readonly readSnapshot?: (
		databasePath: string,
	) => MaybePromise<DatabaseResult<SessionSnapshot>>;
}

interface FallbackDependencies {
	readonly readSnapshot?: ChildAbortDependencies["readSnapshot"];
	readonly deleteSession?: (
		sessionId: string,
		options: {
			readonly databasePath: string;
			readonly expectedTreeToken: string;
		},
	) => Promise<DatabaseResult<MissionControlDeleteResult>>;
}

export type MissionControlChildAbortPreparation =
	| { readonly kind: "stopped"; readonly stdout: string }
	| {
			readonly kind: "fallback";
			readonly plan: MissionControlFallbackPlan;
			readonly notices: readonly string[];
	  }
	| { readonly kind: "failed"; readonly error: string };

const readDefaultSnapshot = (
	databasePath: string,
): DatabaseResult<SessionSnapshot> =>
	getMissionControlSnapshotFromSqlite({ databasePath });

const formatStopFailure = (
	exitCode: number,
	stdout: string,
	stderr: string,
): string => {
	const detail = (stderr || stdout).trim();
	return detail || `Mission Control child stop exited with code ${exitCode}.`;
};

export const prepareMissionControlChildAbort = async (
	selectedSession: Session,
	dependencies: ChildAbortDependencies,
): Promise<MissionControlChildAbortPreparation> => {
	const selectedMetadata = missionControlMetadataOf(selectedSession);
	if (!selectedMetadata)
		return {
			kind: "failed",
			error: "Mission Control control metadata is unavailable.",
		};
	const stopChildren =
		dependencies.stopChildren ??
		((id, path) => stopMissionControlChildren(id, { databasePath: path }));
	let stopped: Awaited<ReturnType<typeof stopChildren>>;
	try {
		stopped = await stopChildren(
			selectedSession.id,
			selectedMetadata.canonicalDatabasePath,
		);
	} catch (error) {
		return {
			kind: "failed",
			error:
				error instanceof Error
					? error.message
					: "Mission Control child stop failed.",
		};
	}
	if (stopped.exitCode === 0) {
		try {
			await dependencies.refreshAfterStop();
		} catch (error) {
			return {
				kind: "failed",
				error:
					error instanceof Error
						? error.message
						: "Mission Control refresh failed.",
			};
		}
		return { kind: "stopped", stdout: stopped.stdout };
	}
	if (stopped.exitCode !== 1)
		return {
			kind: "failed",
			error: formatStopFailure(
				stopped.exitCode,
				stopped.stdout,
				stopped.stderr,
			),
		};
	let refreshed: DatabaseResult<SessionSnapshot>;
	try {
		refreshed = await (dependencies.readSnapshot ?? readDefaultSnapshot)(
			selectedMetadata.canonicalDatabasePath,
		);
	} catch (error) {
		return {
			kind: "failed",
			error:
				error instanceof Error
					? error.message
					: "Mission Control refresh failed.",
		};
	}
	if (!refreshed.ok) return { kind: "failed", error: refreshed.error.message };
	return createMissionControlFallbackPlan(
		selectedSession.id,
		selectedMetadata.canonicalDatabasePath,
		refreshed.value,
	);
};

export const executeMissionControlFallback = async (
	plan: MissionControlFallbackPlan,
	confirmedRootIds: readonly string[],
	dependencies: FallbackDependencies = {},
): Promise<
	| { readonly ok: true; readonly deletedRootIds: readonly string[] }
	| { readonly ok: false; readonly error: string }
> => {
	let refreshed: DatabaseResult<SessionSnapshot>;
	try {
		refreshed = await (dependencies.readSnapshot ?? readDefaultSnapshot)(
			plan.databasePath,
		);
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: "Mission Control refresh failed.",
		};
	}
	if (!refreshed.ok) return { ok: false, error: refreshed.error.message };
	const current = createMissionControlFallbackPlan(
		plan.parentSessionId,
		plan.databasePath,
		refreshed.value,
	);
	if (current.kind !== "fallback")
		return {
			ok: false,
			error:
				current.kind === "failed"
					? current.error
					: "Mission Control fallback state changed.",
		};
	if (
		current.plan.databaseIdentity !== plan.databaseIdentity ||
		JSON.stringify(current.plan.eligibleSessionIds) !==
			JSON.stringify(plan.eligibleSessionIds)
	) {
		return {
			ok: false,
			error:
				"Mission Control fallback survivors changed; no delete was attempted.",
		};
	}
	const tokens = new Map<string, string>();
	for (const plannedRoot of plan.roots) {
		const currentRoot = current.plan.roots.find(
			(root) => root.sessionId === plannedRoot.sessionId,
		);
		if (
			!currentRoot ||
			JSON.stringify(currentRoot.affectedRows) !==
				JSON.stringify(plannedRoot.affectedRows)
		) {
			return {
				ok: false,
				error: `Mission Control subtree changed for ${plannedRoot.sessionId}; no delete was attempted.`,
			};
		}
		const currentRootSession = flattenMissionControlSnapshot(
			refreshed.value,
		).find((session) => session.id === plannedRoot.sessionId);
		const currentToken = currentRootSession
			? missionControlMetadataOf(currentRootSession)?.treeToken
			: undefined;
		if (!currentToken)
			return {
				ok: false,
				error: `Mission Control tree token is unavailable for ${plannedRoot.sessionId}.`,
			};
		tokens.set(plannedRoot.sessionId, currentToken);
	}
	const allowedRoots = new Set(plan.roots.map((root) => root.sessionId));
	if (confirmedRootIds.some((id) => !allowedRoots.has(id)))
		return {
			ok: false,
			error: "Mission Control fallback confirmation is stale.",
		};
	const deleteSession =
		dependencies.deleteSession ?? deleteMissionControlSession;
	const deletedRootIds: string[] = [];
	for (const rootId of confirmedRootIds) {
		const token = tokens.get(rootId);
		if (!token)
			return {
				ok: false,
				error: `Mission Control tree token is unavailable for ${rootId}.`,
			};
		const result = await deleteSession(rootId, {
			databasePath: plan.databasePath,
			expectedTreeToken: token,
		});
		if (!result.ok) return { ok: false, error: result.error.message };
		deletedRootIds.push(rootId);
	}
	return { ok: true, deletedRootIds };
};
