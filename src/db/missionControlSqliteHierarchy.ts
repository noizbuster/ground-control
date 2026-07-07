// Mission Control SQLite hierarchy assembly.
//
// Takes the flat session list produced by the snapshot module and builds the
// parent/child tree using strict precedence:
//   1. sessions.parent_session_id is authoritative (roots = null parent).
//   2. sessions.root_session_id recovers orphans whose direct parent row is
//      missing by re-linking them under the named root.
//   3. session_relations (kind 'subagent' | 'parent_child') fills missing
//      parent links for sessions whose parent_session_id is null — NEVER
//      overriding an explicit parent_session_id.
// Unrecovered orphans surface a "root session not found" session issue.
// Child counts and the active-children status override mirror src/db/pi.ts.

import { isActiveStatus } from "../lib/hierarchyHelpers";
import { type Session, SessionStatus, type SubagentSession } from "../types";

export interface McSessionRelationInput {
	readonly parent_session_id: string | null;
	readonly child_session_id: string;
	readonly kind: string;
}

const FILL_RELATION_KINDS = new Set(["subagent", "parent_child"]);

const resolveRootSessionId = (
	sessionId: string,
	effectiveParent: ReadonlyMap<string, string | null>,
	sessionsById: ReadonlyMap<string, unknown>,
): string | undefined => {
	const seen = new Set<string>([sessionId]);
	let parentId = effectiveParent.get(sessionId) ?? null;
	while (parentId !== null) {
		if (seen.has(parentId)) {
			return undefined;
		}
		seen.add(parentId);
		if (!sessionsById.has(parentId)) {
			return undefined;
		}
		const nextParent = effectiveParent.get(parentId) ?? null;
		if (nextParent === null) {
			return parentId;
		}
		parentId = nextParent;
	}
	return sessionId;
};

export const assembleSqliteHierarchy = (params: {
	flatSessions: readonly Session[];
	rootSessionIdBySessionId: ReadonlyMap<string, string | null>;
	relations: readonly McSessionRelationInput[];
	statusBySessionId: Partial<Record<string, SessionStatus>>;
	sourceLabel: string;
}): {
	sessions: Session[];
	statusBySessionId: Partial<Record<string, SessionStatus>>;
	sessionIssues: Partial<Record<string, string>>;
} => {
	const { flatSessions, rootSessionIdBySessionId, relations, sourceLabel } =
		params;
	const statusBySessionId = params.statusBySessionId;

	const sessionsById = new Map<string, Session>();
	for (const session of flatSessions) {
		sessionsById.set(session.id, session);
	}

	const effectiveParent = new Map<string, string | null>();
	for (const session of flatSessions) {
		effectiveParent.set(session.id, session.parent_id);
	}

	for (const session of flatSessions) {
		const explicitParent = session.parent_id;
		if (explicitParent === null || sessionsById.has(explicitParent)) {
			continue;
		}
		const rootId = rootSessionIdBySessionId.get(session.id) ?? null;
		if (rootId !== null && rootId !== session.id && sessionsById.has(rootId)) {
			effectiveParent.set(session.id, rootId);
		}
	}

	for (const session of flatSessions) {
		if (session.parent_id !== null) {
			continue;
		}
		for (const relation of relations) {
			if (
				relation.child_session_id !== session.id ||
				!FILL_RELATION_KINDS.has(relation.kind) ||
				relation.parent_session_id === null
			) {
				continue;
			}
			const candidateParent = relation.parent_session_id;
			if (candidateParent !== session.id && sessionsById.has(candidateParent)) {
				effectiveParent.set(session.id, candidateParent);
				break;
			}
		}
	}

	const rootSessionsById = new Map<string, Session>();
	for (const session of flatSessions) {
		if ((effectiveParent.get(session.id) ?? null) !== null) {
			continue;
		}
		rootSessionsById.set(session.id, {
			...session,
			subagentSessions: [],
		});
	}

	const sessionIssues: Partial<Record<string, string>> = {};
	for (const session of flatSessions) {
		if ((effectiveParent.get(session.id) ?? null) === null) {
			continue;
		}
		const rootId = resolveRootSessionId(
			session.id,
			effectiveParent,
			sessionsById,
		);
		const rootSession = rootId ? rootSessionsById.get(rootId) : undefined;
		if (!rootSession) {
			sessionIssues[session.id] = `${sourceLabel} root session not found.`;
			continue;
		}
		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			session as SubagentSession,
		];
	}

	for (const rootSession of rootSessionsById.values()) {
		const children = rootSession.subagentSessions ?? [];
		const openChildCount = children.filter((child) =>
			isActiveStatus(child.status),
		).length;
		const closedChildCount = children.length - openChildCount;
		rootSession.sourceMetadata = {
			...rootSession.sourceMetadata,
			openChildCount,
			closedChildCount,
		};
		if (openChildCount > 0) {
			rootSession.status = SessionStatus.running;
			rootSession.statusDetail = `Awaiting ${openChildCount} child session${openChildCount === 1 ? "" : "s"}`;
			statusBySessionId[rootSession.id] = SessionStatus.running;
		}
	}

	return {
		sessions: [...rootSessionsById.values()].sort(
			(left, right) => right.time_updated - left.time_updated,
		),
		statusBySessionId,
		sessionIssues,
	};
};
