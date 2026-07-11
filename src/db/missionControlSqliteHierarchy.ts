import { isActiveStatus } from "../lib/hierarchyHelpers";
import { type Session, SessionStatus, type SubagentSession } from "../types";
import {
	computeMcCanonicalTreeToken,
	getMcCanonicalTreeNodes,
} from "./missionControlSqliteTreeToken";

export interface McSessionRelationInput {
	readonly parent_session_id: string | null;
	readonly child_session_id: string;
	readonly kind: string;
}

const RELATION_KINDS = new Set(["subagent", "parent_child"]);
const MAX_COMPONENT_SESSIONS = 4_096;

const collectComponent = (
	start: string,
	adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> => {
	const component = new Set([start]);
	const pending = [start];
	while (pending.length > 0) {
		const current = pending.shift();
		if (current === undefined) break;
		for (const related of adjacency.get(current) ?? []) {
			if (component.has(related)) continue;
			component.add(related);
			pending.push(related);
		}
	}
	return component;
};

const hasCycle = (
	component: ReadonlySet<string>,
	parents: ReadonlyMap<string, string | null>,
): boolean => {
	for (const sessionId of component) {
		const seen = new Set<string>();
		let current: string | null = sessionId;
		while (current !== null && component.has(current)) {
			if (seen.has(current)) return true;
			seen.add(current);
			current = parents.get(current) ?? null;
		}
	}
	return false;
};

const addEdge = (
	childId: string,
	parentId: string,
	sessions: ReadonlyMap<string, Session>,
	adjacency: Map<string, Set<string>>,
	issues: Map<string, string>,
): void => {
	if (childId === parentId) {
		issues.set(childId, "self-parent edge");
		return;
	}
	if (!sessions.has(parentId)) {
		issues.set(childId, `parent ${JSON.stringify(parentId)} not found`);
		return;
	}
	adjacency.get(childId)?.add(parentId);
	adjacency.get(parentId)?.add(childId);
};

const cloneWithCanonicalMetadata = (
	session: Session,
	parentId: string | null,
	token: string,
): Session => ({
	...session,
	parent_id: parentId,
	sourceMetadata: {
		...session.sourceMetadata,
		missionControl: session.sourceMetadata?.missionControl
			? {
					...session.sourceMetadata.missionControl,
					effectiveParentId: parentId,
					treeToken: token,
				}
			: undefined,
	},
	subagentSessions: [],
});

export const assembleSqliteHierarchy = (params: {
	flatSessions: readonly Session[];
	relations: readonly McSessionRelationInput[];
	statusBySessionId: Partial<Record<string, SessionStatus>>;
	sourceLabel: string;
}): {
	sessions: Session[];
	statusBySessionId: Partial<Record<string, SessionStatus>>;
	sessionIssues: Partial<Record<string, string>>;
} => {
	const sessions = new Map(
		params.flatSessions.map((session) => [session.id, session]),
	);
	const parents = new Map<string, string | null>();
	const adjacency = new Map<string, Set<string>>(
		params.flatSessions.map((session) => [session.id, new Set<string>()]),
	);
	const issues = new Map<string, string>();
	const fallbacks = new Map<string, McSessionRelationInput[]>();
	for (const relation of params.relations) {
		if (
			!RELATION_KINDS.has(relation.kind) ||
			relation.parent_session_id === null
		)
			continue;
		const child = sessions.get(relation.child_session_id);
		if (child === undefined || child.parent_id !== null) continue;
		const candidates = fallbacks.get(child.id) ?? [];
		candidates.push(relation);
		fallbacks.set(child.id, candidates);
	}
	for (const session of params.flatSessions) {
		if (session.parent_id !== null) {
			parents.set(session.id, session.parent_id);
			addEdge(session.id, session.parent_id, sessions, adjacency, issues);
			continue;
		}
		const candidates = fallbacks.get(session.id) ?? [];
		if (candidates.length === 0) {
			parents.set(session.id, null);
			continue;
		}
		if (candidates.length > 1)
			issues.set(session.id, "multiple eligible parent relations");
		const selected = candidates[0]?.parent_session_id ?? null;
		parents.set(session.id, selected);
		for (const candidate of candidates) {
			if (candidate.parent_session_id !== null) {
				addEdge(
					session.id,
					candidate.parent_session_id,
					sessions,
					adjacency,
					issues,
				);
			}
		}
	}

	const statusBySessionId = { ...params.statusBySessionId };
	const sessionIssues: Partial<Record<string, string>> = {};
	const roots: Session[] = [];
	const visited = new Set<string>();
	for (const sessionId of sessions.keys()) {
		if (visited.has(sessionId)) continue;
		const component = collectComponent(sessionId, adjacency);
		for (const member of component) visited.add(member);
		if (component.size > MAX_COMPONENT_SESSIONS) {
			for (const member of component) {
				sessionIssues[member] =
					`${params.sourceLabel} unstable session hierarchy: component exceeds ${MAX_COMPONENT_SESSIONS} sessions.`;
			}
			continue;
		}
		const cycle = hasCycle(component, parents);
		const unstable =
			cycle || [...component].some((member) => issues.has(member));
		if (unstable) {
			for (const member of component) {
				const detail =
					issues.get(member) ??
					(cycle ? "cycle detected" : "connected component conflict");
				sessionIssues[member] =
					`${params.sourceLabel} unstable session hierarchy: ${detail}.`;
			}
			continue;
		}
		const rootId = [...component].find(
			(member) => (parents.get(member) ?? null) === null,
		);
		if (rootId === undefined) continue;
		const rootSource = sessions.get(rootId);
		if (rootSource === undefined) continue;
		const canonical = new Map<string, Session>();
		for (const member of component) {
			const source = sessions.get(member);
			if (source === undefined) continue;
			canonical.set(
				member,
				cloneWithCanonicalMetadata(
					source,
					parents.get(member) ?? null,
					computeMcCanonicalTreeToken(member, parents, component),
				),
			);
		}
		const root = canonical.get(rootId);
		if (root === undefined) continue;
		const subagents: SubagentSession[] = [];
		for (const { sessionId: childId } of getMcCanonicalTreeNodes(
			rootId,
			parents,
			component,
		).slice(1)) {
			const child = canonical.get(childId);
			if (child !== undefined) subagents.push(child);
		}
		root.subagentSessions = subagents;
		const openChildCount = root.subagentSessions.filter((child) =>
			isActiveStatus(child.status),
		).length;
		root.sourceMetadata = {
			...root.sourceMetadata,
			openChildCount,
			closedChildCount: root.subagentSessions.length - openChildCount,
		};
		if (openChildCount > 0) {
			root.status = SessionStatus.running;
			root.statusDetail = `Awaiting ${openChildCount} child session${openChildCount === 1 ? "" : "s"}`;
			statusBySessionId[root.id] = SessionStatus.running;
		}
		roots.push(root);
	}
	return {
		sessions: roots.sort(
			(left, right) => right.time_updated - left.time_updated,
		),
		statusBySessionId,
		sessionIssues,
	};
};
