/**
 * Pure hierarchy utilities for agent session hierarchy views.
 *
 * This module contains no UI imports, no async work, and no global state.
 * All functions are pure and return typed data structures that can be
 * consumed by tree or flow renderers.
 */
import {
	type HierarchyFilterMode,
	type HierarchyInfoMode,
	type HierarchyViewMode,
	type Session,
	SessionStatus,
	type SubagentSession,
} from "../types";

// ============================================================================
// Types
// ============================================================================

/** Represents a node in the hierarchy (root session or subagent). */
export interface HierarchyNode {
	/** Session ID */
	id: string;
	/** Session title (may be truncated) */
	title: string;
	/** Current agent name if available */
	agent?: string;
	modelID?: string;
	variant?: string;
	/** Session status */
	status: SessionStatus;
	/** Depth in hierarchy (0 = root) */
	depth: number;
	/** Parent session ID if this is a subagent */
	parentId?: string;
	/** Whether this is the root session */
	isRoot: boolean;
	/** Original session record for detailed info access */
	original: Session | SubagentSession;
}

/** Standard node info - minimal display data */
export interface StandardNodeInfo {
	id: string;
	title: string;
	status: SessionStatus;
	agent?: string;
	modelID?: string;
	variant?: string;
	depth: number;
	finishReason?: string;
}

/** Detailed node info - full display data */
export interface DetailedNodeInfo extends StandardNodeInfo {
	timeCreated: number;
	timeUpdated: number;
	projectLabel: string;
	directory: string;
	parentId?: string;
	messageCount?: number;
	subagentCount: number;
}

/** Indentation metadata for tree rendering */
export interface TreeIndentMeta {
	/** Number of indentation units (e.g., spaces or connector chars) */
	indentLevel: number;
	/** Visual prefix string for the node */
	prefix: string;
	/** Whether this node is the last child in its parent */
	isLastChild: boolean;
	hasChildren: boolean;
	/** Array of booleans indicating if ancestors have more siblings */
	ancestorHasMore: boolean[];
}

/** Indentation metadata for flow rendering */
export interface FlowIndentMeta {
	/** Column index in flow layout */
	columnIndex: number;
	/** Row index in flow layout */
	rowIndex: number;
	/** Whether this is a continuation from previous row */
	isContinuation: boolean;
}

/** Combined indentation metadata union */
export type IndentMeta = TreeIndentMeta | FlowIndentMeta;

/** A single line in the hierarchy display */
export interface HierarchyLine {
	/** The node being displayed */
	node: HierarchyNode;
	/** Standard node info */
	standardInfo: StandardNodeInfo;
	/** Detailed node info (computed on demand for detailed mode) */
	detailedInfo?: DetailedNodeInfo;
	/** Indentation metadata for the current view mode */
	indent: IndentMeta;
	/** The view mode this line was generated for */
	viewMode: HierarchyViewMode;
	/** The info mode used when generating this line */
	infoMode: HierarchyInfoMode;
}

// ============================================================================
// Status Predicates
// ============================================================================

/** Active statuses: pending, running, waiting */
export const isActiveStatus = (status?: SessionStatus): boolean => {
	return (
		status === SessionStatus.pending ||
		status === SessionStatus.running ||
		status === SessionStatus.waiting
	);
};

/** Terminal statuses: completed, failed, unknown */
export const isTerminalStatus = (status?: SessionStatus): boolean => {
	return (
		status === SessionStatus.completed ||
		status === SessionStatus.failed ||
		status === SessionStatus.unknown
	);
};

/** Running status only */
export const isRunningStatus = (status?: SessionStatus): boolean => {
	return status === SessionStatus.running;
};

// ============================================================================
// Filter Helpers
// ============================================================================

/**
 * Check if a session should be visible based on filter mode.
 * - "all": always visible
 * - "active": visible if status is pending/running/waiting
 * - "latest": visible if active OR if it's the most recent terminal session among siblings
 */
export const isSessionVisible = (
	session: Session | SubagentSession,
	filterMode: HierarchyFilterMode,
): boolean => {
	if (filterMode === "all") {
		return true;
	}

	if (filterMode === "active") {
		return isActiveStatus(session.status);
	}

	return isActiveStatus(session.status);
};

const buildChildrenByParentId = (
	subagents: SubagentSession[],
): Map<string, SubagentSession[]> => {
	const childrenByParentId = new Map<string, SubagentSession[]>();
	const subagentIds = new Set(subagents.map((s) => s.id));

	for (const subagent of subagents) {
		const parentId = subagent.parent_id;
		if (!parentId || parentId === subagent.id || !subagentIds.has(parentId)) {
			continue;
		}

		const existing = childrenByParentId.get(parentId);
		if (existing) {
			existing.push(subagent);
		} else {
			childrenByParentId.set(parentId, [subagent]);
		}
	}

	return childrenByParentId;
};

const hasActiveChildren = (
	subagentId: string,
	childrenByParentId: Map<string, SubagentSession[]>,
): boolean => {
	const children = childrenByParentId.get(subagentId);
	if (!children) {
		return false;
	}

	return children.some((child) => isActiveStatus(child.status));
};

/**
 * Filter subagent sessions based on filter mode.
 * Note: Root session visibility is handled by the caller.
 */
export const filterSubagentSessions = (
	subagents: SubagentSession[],
	filterMode: HierarchyFilterMode,
): SubagentSession[] => {
	if (filterMode === "all") {
		return subagents;
	}

	if (filterMode === "active") {
		return subagents.filter((s) => isActiveStatus(s.status));
	}

	const childrenByParentId = buildChildrenByParentId(subagents);

	const active = subagents.filter((s) => isActiveStatus(s.status));
	const terminal = subagents.filter(
		(s) =>
			isTerminalStatus(s.status) &&
			!hasActiveChildren(s.id, childrenByParentId),
	);
	const awaitingSubagent = subagents.filter(
		(s) =>
			isTerminalStatus(s.status) && hasActiveChildren(s.id, childrenByParentId),
	);

	if (terminal.length === 0) {
		return [...active, ...awaitingSubagent];
	}

	const sortedTerminal = [...terminal].sort(
		(a, b) => (b.time_updated ?? 0) - (a.time_updated ?? 0),
	);

	return [...active, ...awaitingSubagent, sortedTerminal[0]];
};

/**
 * Filter a root session's hierarchy based on filter mode.
 * Returns the session with filtered subagents.
 * Root session is always preserved (caller decides root visibility).
 */
export const filterHierarchySession = (
	session: Session,
	filterMode: HierarchyFilterMode,
): Session => {
	if (!session.subagentSessions || session.subagentSessions.length === 0) {
		return session;
	}

	const filteredSubagents = filterSubagentSessions(
		session.subagentSessions,
		filterMode,
	);

	return {
		...session,
		subagentSessions: filteredSubagents,
	};
};

/**
 * Filter an array of root sessions based on filter mode.
 * Applies filtering to subagents but preserves all root sessions.
 */
export const filterHierarchySessions = (
	sessions: Session[],
	filterMode: HierarchyFilterMode,
): Session[] => {
	return sessions.map((session) => filterHierarchySession(session, filterMode));
};

// ============================================================================
// Node Conversion
// ============================================================================

/** Convert a Session or SubagentSession to a HierarchyNode */
export const toHierarchyNode = (
	session: Session | SubagentSession,
	depth: number,
	isRoot: boolean,
): HierarchyNode => {
	return {
		id: session.id,
		title: session.title ?? "Untitled",
		agent: session.currentAgent,
		modelID: session.currentModelID,
		variant: session.currentVariant,
		status: session.status ?? SessionStatus.unknown,
		depth,
		parentId: isRoot
			? undefined
			: ((session as SubagentSession).parent_id ?? undefined),
		isRoot,
		original: session,
	};
};

interface FlattenedHierarchyEntry {
	node: HierarchyNode;
	siblingIndex: number;
	siblingCount: number;
	hasChildren: boolean;
	ancestorHasMore: boolean[];
}

const normalizeParentId = (
	subagent: SubagentSession,
	rootSessionId: string,
	subagentIds: Set<string>,
): string => {
	const parentId = subagent.parent_id;

	if (!parentId || parentId === subagent.id) {
		return rootSessionId;
	}

	if (parentId === rootSessionId || subagentIds.has(parentId)) {
		return parentId;
	}

	return rootSessionId;
};

const buildSubagentChildrenMap = (
	session: Session,
): Map<string, SubagentSession[]> => {
	const childrenByParentId = new Map<string, SubagentSession[]>();
	const subagents = session.subagentSessions ?? [];
	const subagentIds = new Set(subagents.map((subagent) => subagent.id));

	for (const subagent of subagents) {
		const parentId = normalizeParentId(subagent, session.id, subagentIds);
		const existingChildren = childrenByParentId.get(parentId);

		if (existingChildren) {
			existingChildren.push(subagent);
			continue;
		}

		childrenByParentId.set(parentId, [subagent]);
	}

	return childrenByParentId;
};

const flattenHierarchyEntries = (
	session: Session,
): FlattenedHierarchyEntry[] => {
	const subagents = session.subagentSessions ?? [];
	const entries: FlattenedHierarchyEntry[] = [
		{
			node: toHierarchyNode(session, 0, true),
			siblingIndex: 0,
			siblingCount: 1,
			hasChildren: subagents.length > 0,
			ancestorHasMore: [],
		},
	];

	if (subagents.length === 0) {
		return entries;
	}

	const childrenByParentId = buildSubagentChildrenMap(session);
	const visited = new Set<string>();
	const hasChildren = (sessionId: string): boolean => {
		return (childrenByParentId.get(sessionId)?.length ?? 0) > 0;
	};

	const visitChildren = (
		parentId: string,
		depth: number,
		ancestorHasMore: boolean[],
	): void => {
		const children = childrenByParentId.get(parentId) ?? [];
		const siblingCount = children.length;

		children.forEach((child, siblingIndex) => {
			if (visited.has(child.id)) {
				return;
			}

			visited.add(child.id);
			entries.push({
				node: toHierarchyNode(child, depth, false),
				siblingIndex,
				siblingCount,
				hasChildren: hasChildren(child.id),
				ancestorHasMore,
			});

			const hasMoreSiblings = siblingIndex < siblingCount - 1;
			visitChildren(child.id, depth + 1, [...ancestorHasMore, hasMoreSiblings]);
		});
	};

	visitChildren(session.id, 1, []);

	for (const subagent of subagents) {
		if (visited.has(subagent.id)) {
			continue;
		}

		visited.add(subagent.id);
		entries.push({
			node: toHierarchyNode(subagent, 1, false),
			siblingIndex: 0,
			siblingCount: 1,
			hasChildren: hasChildren(subagent.id),
			ancestorHasMore: [],
		});
		visitChildren(subagent.id, 2, [false]);
	}

	return entries;
};

/** Extract all nodes from a session hierarchy in depth-first order */
export const flattenHierarchy = (
	session: Session,
	_messageCountBySessionId?: Partial<Record<string, number>>,
): HierarchyNode[] => {
	return flattenHierarchyEntries(session).map((entry) => entry.node);
};

/** Extract all nodes from multiple session hierarchies */
export const flattenHierarchies = (
	sessions: Session[],
	messageCountBySessionId?: Partial<Record<string, number>>,
): HierarchyNode[] => {
	return sessions.flatMap((session) =>
		flattenHierarchy(session, messageCountBySessionId),
	);
};

// ============================================================================
// Label Helpers
// ============================================================================

const DEFAULT_MAX_LABEL_LENGTH = 40;
const ELLIPSIS = "...";

/**
 * Truncate a label to a maximum length, preserving the start and end.
 */
export const truncateLabel = (
	label: string,
	maxLength: number = DEFAULT_MAX_LABEL_LENGTH,
): string => {
	if (label.length <= maxLength) {
		return label;
	}

	const firstPart = Math.floor(maxLength * 0.6);
	const ellipsisSpace = ELLIPSIS.length;

	const adjustedFirst = firstPart;
	const adjustedLast = maxLength - adjustedFirst - ellipsisSpace;

	if (adjustedLast <= 0) {
		return label.slice(0, maxLength - ellipsisSpace) + ELLIPSIS;
	}

	return label.slice(0, adjustedFirst) + ELLIPSIS + label.slice(-adjustedLast);
};

/**
 * Truncate a label by preserving the end (more useful for IDs).
 */
export const truncateLabelEnd = (
	label: string,
	maxLength: number = DEFAULT_MAX_LABEL_LENGTH,
): string => {
	if (label.length <= maxLength) {
		return label;
	}

	return ELLIPSIS + label.slice(-(maxLength - ELLIPSIS.length));
};

// ============================================================================
// Node Info Helpers
// ============================================================================

/**
 * Get standard (minimal) node info.
 */
export const getStandardNodeInfo = (node: HierarchyNode): StandardNodeInfo => {
	return {
		id: node.id,
		title: truncateLabel(node.title),
		status: node.status,
		agent: node.agent,
		modelID: node.modelID,
		variant: node.variant,
		depth: node.depth,
		finishReason: node.original?.finishReason,
	};
};

/**
 * Get detailed node info.
 * Requires message count map for complete info.
 */
export const getDetailedNodeInfo = (
	node: HierarchyNode,
	messageCountBySessionId?: Partial<Record<string, number>>,
): DetailedNodeInfo => {
	const original = node.original;
	const subagentCount =
		"subagentSessions" in original
			? (original.subagentSessions?.length ?? 0)
			: 0;

	return {
		id: node.id,
		title: truncateLabel(node.title, 60),
		status: node.status,
		agent: node.agent,
		modelID: node.modelID,
		variant: node.variant,
		depth: node.depth,
		timeCreated: original.time_created,
		timeUpdated: original.time_updated,
		projectLabel: original.project_label ?? original.project_id,
		directory: original.directory,
		parentId: node.parentId,
		messageCount: messageCountBySessionId?.[node.id],
		subagentCount,
	};
};

// ============================================================================
// Tree Indentation Helpers
// ============================================================================

const TREE_CONNECTORS = {
	/** Vertical line continuing from parent */
	vertical: "│",
	/** Branch pointing to child */
	branch: "├",
	/** Last child branch */
	branchLast: "└",
	/** Horizontal connector */
	horizontal: "─",
	/** Space for alignment */
	space: " ",
} as const;

/**
 * Build tree indentation metadata for a node at a given position.
 */
export const buildTreeIndentMeta = (
	node: HierarchyNode,
	siblingIndex: number,
	siblingCount: number,
	ancestorHasMore: boolean[] = [],
	hasChildren: boolean = false,
): TreeIndentMeta => {
	const isLastChild = siblingIndex === siblingCount - 1;
	const indentLevel = node.depth;
	const prefix = buildTreePrefix(node.depth, isLastChild, ancestorHasMore);

	return {
		indentLevel,
		prefix,
		isLastChild,
		hasChildren,
		ancestorHasMore,
	};
};

/**
 * Build the visual prefix string for a tree node.
 */
export const buildTreePrefix = (
	depth: number,
	isLastChild: boolean,
	ancestorHasMore: boolean[],
): string => {
	if (depth === 0) {
		return "";
	}

	const parts: string[] = [];

	for (let i = 0; i < depth - 1; i++) {
		if (ancestorHasMore[i]) {
			parts.push(TREE_CONNECTORS.vertical + TREE_CONNECTORS.space);
		} else {
			parts.push(TREE_CONNECTORS.space + TREE_CONNECTORS.space);
		}
	}

	if (isLastChild) {
		parts.push(TREE_CONNECTORS.branchLast + TREE_CONNECTORS.horizontal);
	} else {
		parts.push(TREE_CONNECTORS.branch + TREE_CONNECTORS.horizontal);
	}

	return parts.join("");
};

// ============================================================================
// Flow Indentation Helpers
// ============================================================================

/**
 * Build flow indentation metadata for a node.
 */
export const buildFlowIndentMeta = (
	columnIndex: number,
	rowIndex: number,
	isContinuation: boolean = false,
): FlowIndentMeta => {
	return {
		columnIndex,
		rowIndex,
		isContinuation,
	};
};

/**
 * Calculate flow layout positions for a set of nodes.
 * Returns a map of node ID to flow indent metadata.
 */
export const calculateFlowLayout = (
	nodes: HierarchyNode[],
	columnsPerRow: number = 3,
): Map<string, FlowIndentMeta> => {
	const layout = new Map<string, FlowIndentMeta>();

	nodes.forEach((node, index) => {
		const columnIndex = index % columnsPerRow;
		const rowIndex = Math.floor(index / columnsPerRow);
		const isContinuation = rowIndex > 0 && columnIndex === 0;

		layout.set(
			node.id,
			buildFlowIndentMeta(columnIndex, rowIndex, isContinuation),
		);
	});

	return layout;
};

// ============================================================================
// Line Building
// ============================================================================

/**
 * Build hierarchy lines for a single session in tree mode.
 */
export const buildTreeLines = (
	session: Session,
	messageCountBySessionId?: Partial<Record<string, number>>,
	infoMode: HierarchyInfoMode = "standard",
): HierarchyLine[] => {
	const lines: HierarchyLine[] = [];
	const entries = flattenHierarchyEntries(session);

	entries.forEach((entry) => {
		const { node, siblingIndex, siblingCount, ancestorHasMore, hasChildren } =
			entry;

		const indent = buildTreeIndentMeta(
			node,
			siblingIndex,
			siblingCount,
			ancestorHasMore,
			hasChildren,
		);

		const standardInfo = getStandardNodeInfo(node);
		const detailedInfo =
			infoMode === "detailed"
				? getDetailedNodeInfo(node, messageCountBySessionId)
				: undefined;

		lines.push({
			node,
			standardInfo,
			detailedInfo,
			indent,
			viewMode: "tree",
			infoMode,
		});
	});

	return lines;
};

/**
 * Build hierarchy lines for a single session in flow mode.
 */
export const buildFlowLines = (
	session: Session,
	messageCountBySessionId?: Partial<Record<string, number>>,
	infoMode: HierarchyInfoMode = "standard",
	columnsPerRow: number = 3,
): HierarchyLine[] => {
	const lines: HierarchyLine[] = [];
	const nodes = flattenHierarchy(session, messageCountBySessionId);
	const flowLayout = calculateFlowLayout(nodes, columnsPerRow);

	nodes.forEach((node) => {
		const flowMeta = flowLayout.get(node.id);
		if (!flowMeta) {
			return;
		}

		const standardInfo = getStandardNodeInfo(node);
		const detailedInfo =
			infoMode === "detailed"
				? getDetailedNodeInfo(node, messageCountBySessionId)
				: undefined;

		lines.push({
			node,
			standardInfo,
			detailedInfo,
			indent: flowMeta,
			viewMode: "flow",
			infoMode,
		});
	});

	return lines;
};

/**
 * Build hierarchy lines for a session based on view mode.
 */
export const buildHierarchyLines = (
	session: Session,
	viewMode: HierarchyViewMode,
	infoMode: HierarchyInfoMode = "standard",
	messageCountBySessionId?: Partial<Record<string, number>>,
	options?: { columnsPerRow?: number },
): HierarchyLine[] => {
	if (viewMode === "flow") {
		return buildFlowLines(
			session,
			messageCountBySessionId,
			infoMode,
			options?.columnsPerRow ?? 3,
		);
	}

	return buildTreeLines(session, messageCountBySessionId, infoMode);
};

/**
 * Build hierarchy lines for multiple sessions.
 */
export const buildAllHierarchyLines = (
	sessions: Session[],
	viewMode: HierarchyViewMode,
	infoMode: HierarchyInfoMode = "standard",
	messageCountBySessionId?: Partial<Record<string, number>>,
	options?: { columnsPerRow?: number },
): HierarchyLine[] => {
	return sessions.flatMap((session) =>
		buildHierarchyLines(
			session,
			viewMode,
			infoMode,
			messageCountBySessionId,
			options,
		),
	);
};

// ============================================================================
// Status Label Helpers
// ============================================================================

/** Map from status to display label */
export const STATUS_LABEL_MAP: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "Pending",
	[SessionStatus.running]: "Running",
	[SessionStatus.waiting]: "Waiting",
	[SessionStatus.completed]: "Completed",
	[SessionStatus.failed]: "Failed",
	[SessionStatus.unknown]: "Unknown",
} as const;

const AWAITING_SUBAGENT_STATUS_LABEL = "AWAITING SUBAGENT";
const IDLE_STATUS_LABEL = "Idle";
const IDLE_WAITING_FINISH_REASONS = new Set(["end_turn", "active_session"]);

export interface StatusDisplayOptions {
	runningSubagents?: number;
	finishReason?: string;
}

export const getDisplayStatus = (
	status?: SessionStatus,
	options: StatusDisplayOptions = {},
): SessionStatus => {
	const resolvedStatus = status ?? SessionStatus.unknown;

	if (
		resolvedStatus === SessionStatus.waiting &&
		options.finishReason &&
		IDLE_WAITING_FINISH_REASONS.has(options.finishReason)
	) {
		return SessionStatus.completed;
	}

	if (
		resolvedStatus === SessionStatus.completed &&
		(options.runningSubagents ?? 0) > 0
	) {
		return SessionStatus.running;
	}

	return resolvedStatus;
};

export const getStatusLabel = (
	status?: SessionStatus,
	options: StatusDisplayOptions = {},
): string => {
	if (
		status === SessionStatus.completed &&
		(options.runningSubagents ?? 0) > 0
	) {
		return AWAITING_SUBAGENT_STATUS_LABEL;
	}

	if (
		status === SessionStatus.waiting &&
		options.finishReason &&
		IDLE_WAITING_FINISH_REASONS.has(options.finishReason)
	) {
		return IDLE_STATUS_LABEL;
	}

	const displayStatus = getDisplayStatus(status, options);
	const baseLabel =
		STATUS_LABEL_MAP[displayStatus] ?? STATUS_LABEL_MAP[SessionStatus.unknown];
	const finishReason = options.finishReason;
	if (
		finishReason &&
		finishReason !== "stop" &&
		finishReason !== "tool-calls" &&
		finishReason !== "error"
	) {
		return `${baseLabel} (${finishReason})`;
	}
	return baseLabel;
};

// ============================================================================
// Sort Helpers
// ============================================================================

/**
 * Get sort rank for a status (lower = higher priority for display).
 * Running sessions are shown first, then other active, then terminal.
 */
export const getStatusSortRank = (status?: SessionStatus): number => {
	switch (status) {
		case SessionStatus.running:
			return 0;
		case SessionStatus.waiting:
			return 1;
		case SessionStatus.pending:
			return 2;
		case SessionStatus.completed:
			return 3;
		case SessionStatus.failed:
			return 4;
		default:
			return 5;
	}
};

/**
 * Sort subagent sessions by status priority, then by time.
 */
export const sortSubagentsByStatus = (
	subagents: SubagentSession[],
): SubagentSession[] => {
	return [...subagents].sort((a, b) => {
		const rankA = getStatusSortRank(a.status);
		const rankB = getStatusSortRank(b.status);

		if (rankA !== rankB) {
			return rankA - rankB;
		}

		return (b.time_updated ?? 0) - (a.time_updated ?? 0);
	});
};

// ============================================================================
// Aggregation Helpers
// ============================================================================

/**
 * Count active subagents in a session.
 */
export const countActiveSubagents = (session: Session): number => {
	return (session.subagentSessions ?? []).filter((s) =>
		isActiveStatus(s.status),
	).length;
};

/**
 * Count running subagents in a session.
 */
export const countRunningSubagents = (session: Session): number => {
	return (session.subagentSessions ?? []).filter((s) =>
		isRunningStatus(s.status),
	).length;
};

/**
 * Get summary info for a session's subagent hierarchy.
 */
export const getSubagentSummary = (
	session: Session,
): {
	total: number;
	active: number;
	running: number;
	terminal: number;
} => {
	const subagents = session.subagentSessions ?? [];
	return {
		total: subagents.length,
		active: subagents.filter((s) => isActiveStatus(s.status)).length,
		running: subagents.filter((s) => isRunningStatus(s.status)).length,
		terminal: subagents.filter((s) => isTerminalStatus(s.status)).length,
	};
};
