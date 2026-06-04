import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	Box,
	type BoxRenderable,
	bold,
	createCliRenderer,
	dim,
	fg,
	isRenderable,
	type KeyEvent,
	MouseButton,
	type Renderable,
	ScrollBox,
	type ScrollBoxRenderable,
	Text,
	type TextRenderable,
	t,
} from "@opentui/core";
import { deleteClaudeSession } from "./db/claude";
import { deleteCodexSession } from "./db/codex";
import { abortCodexChildSession } from "./db/codex-child-abort";
import { deleteOmpSession, deletePiSession } from "./db/pi";
import {
	createErrorResponse,
	createRequest,
	isRefreshResponse,
	type RefreshResponse,
	type RefreshSnapshotPayload,
} from "./db/refresh-worker-protocol";
import {
	getExternalAttachedDirectoryKey,
	parseAttachedSessionIdsFromProcessList,
} from "./lib/attachedSessionSignals";
import { clampGridScrollTop, getGridVisibleRowCount } from "./lib/gridScroll";
import {
	createRefreshCoordinator,
	type RefreshRequestId,
} from "./lib/refreshCoordinator";
import {
	applySessionFilter,
	applySessionSort,
	normalizeDirectoryPath,
	type SessionFilterMode,
	type SessionSortMode,
} from "./lib/sessionList";
import type { SessionStatusById } from "./lib/sessionSnapshot";
import {
	canAbortSessionChildren,
	canAttachToSession,
	canDeleteSession,
	countSessionsBySource,
	getAttachLaunchEnvironment,
	getAttachLaunchSpec,
	getSessionSourceLabel,
} from "./lib/sessionSource";
import {
	type HierarchyFilterMode,
	type HierarchyInfoMode,
	type HierarchyViewMode,
	type Session,
	SessionStatus,
	type SubagentSession,
} from "./types";
import { createDetailPanelContent } from "./ui/DetailPanel";
import {
	createHierarchyViewContent,
	getHierarchyTimelineContextWidth,
	getTimelineTrackWidth,
} from "./ui/HierarchyView";
import { SESSION_CARD_MAX_HEIGHT } from "./ui/SessionCard";
import {
	createSessionGridContent,
	getGridColumnCount,
	SESSION_GRID_ROW_GAP,
} from "./ui/SessionGrid";

const APP_ROOT_ID = "session-monitor-root";
const FOOTER_CONTAINER_ID = "session-monitor-footer";
const STATUS_TEXT_ID = "session-monitor-status";
const CONTROL_TEXT_ID = "session-monitor-controls";
const CONTENT_CONTAINER_ID = "session-monitor-content";
const DELETE_CONFIRMATION_OVERLAY_ID = "session-monitor-delete-confirmation";
const TOAST_OVERLAY_ID = "toast-overlay";
const GRID_SCROLLBOX_ID = "session-grid-scrollbox";
const GRID_CONTENT_ID = "session-grid-content";
const DETAIL_SCROLLBOX_ID = "session-detail-scrollbox";
const DETAIL_CONTENT_ID = "session-detail-content";
const HIERARCHY_CONTAINER_ID = "session-hierarchy-container";
const HIERARCHY_HEADER_ID = "session-hierarchy-header";
const HIERARCHY_TIMELINE_ANCHOR_ID = "session-hierarchy-timeline-anchor";
const HIERARCHY_SCROLLBOX_ID = "session-hierarchy-scrollbox";
const HIERARCHY_CONTENT_ID = "session-hierarchy-content";
const POLL_INTERVAL_MS = 2000;
const RESIZE_DEBOUNCE_MS = 150;
const WAITING_PULSE_FRAME_INTERVAL_MS = 80;
const DETAIL_SCROLL_STEP = 3;
const SIDEVIEW_SHORTCUT_LABEL = "e/p";
const FILTER_SHORTCUT_LABEL = "f";
const ATTACH_SHORTCUT_LABEL = "a";
const COPY_ID_SHORTCUT_LABEL = "i";
const DELETE_SHORTCUT_LABEL = "d";
const KILL_CHILDREN_SHORTCUT_LABEL = "K";
const SORT_SHORTCUT_LABEL = "s";
const TIMELINE_SHORTCUT_LABEL = "t";
const HIERARCHY_NARROW_THRESHOLD = 56;
const HIERARCHY_SHORTCUT_LABEL = "c";
const HIERARCHY_CONTAINER_HORIZONTAL_INSET = 2;
const HIERARCHY_FRAME_VERTICAL_INSET = 2;
const HIERARCHY_SCROLLBOX_CONTENT_HORIZONTAL_INSET = 2;
const HIERARCHY_TIMELINE_SECTION_HORIZONTAL_INSET = 4;
const ROOT_PADDING_TOP = 1;
const ROOT_PADDING_X = 2;
const ROOT_CONTENT_GAP = 1;
const FOOTER_INLINE_GAP = 1;
const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";
const ATTACH_DEBUG_OUTPUT_TAIL_LENGTH = 4000;
const ATTACH_DEBUG_DIRECTORY = join(homedir(), ".cache", "gctrl");
const DEFAULT_ATTACH_DEBUG_PATH = join(
	ATTACH_DEBUG_DIRECTORY,
	"attach-debug.log",
);

type FocusPane = "grid" | "detail";
const SESSION_FILTER_CYCLE: SessionFilterMode[] = [
	"active",
	"recent",
	"busy",
	"all",
];
const SESSION_SORT_CYCLE: SessionSortMode[] = ["status", "update", "create"];
const HIERARCHY_FILTER_CYCLE: HierarchyFilterMode[] = [
	"latest",
	"active",
	"all",
];
const HIERARCHY_VIEW_CYCLE: HierarchyViewMode[] = ["tree", "flow"];
const HIERARCHY_INFO_CYCLE: HierarchyInfoMode[] = ["standard", "detailed"];

interface SelectionSnapshot {
	isDragging?: boolean;
	isStart?: boolean;
	getSelectedText(): string;
}

const getSelectionText = (selection: SelectionSnapshot | null): string => {
	return typeof selection?.getSelectedText === "function"
		? selection.getSelectedText().trim()
		: "";
};

const APP_PALETTE = {
	bg: "#020617",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
	danger: "#F87171",
	warning: "#F59E0B",
} as const;

const getSafeNumber = (value: number | undefined, fallback: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}

	return Math.max(Math.floor(value), 0);
};

const sanitizeText = (
	value: string | null | undefined,
	fallback: string,
): string => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const clampSelection = (sessions: Session[], selectedIndex: number): number => {
	if (sessions.length === 0) {
		return -1;
	}

	if (selectedIndex < 0) {
		return 0;
	}

	if (selectedIndex >= sessions.length) {
		return sessions.length - 1;
	}

	return selectedIndex;
};

const getGridWidth = (
	terminalWidth: number,
	isSideviewMode: boolean,
): number => {
	if (!isSideviewMode) {
		return terminalWidth;
	}

	const detailWidth = Math.max(Math.floor(terminalWidth * 0.34), 22);
	return Math.max(terminalWidth - detailWidth - 1, 1);
};

const getRenderedGridColumnCount = (
	gridContentRenderable: Renderable | undefined,
	fallbackColumnCount: number,
): number => {
	if (!isBoxRenderable(gridContentRenderable)) {
		return Math.max(1, fallbackColumnCount);
	}

	const [gridRowsRenderable] = gridContentRenderable.getChildren();
	if (!isRenderable(gridRowsRenderable)) {
		return Math.max(1, fallbackColumnCount);
	}

	const visibleCards = gridRowsRenderable
		.getChildren()
		.filter((renderable) => renderable.visible);

	if (visibleCards.length === 0) {
		return Math.max(1, fallbackColumnCount);
	}

	const firstRowY = visibleCards[0].y;
	let inferredColumnCount = 0;

	for (const card of visibleCards) {
		if (card.y !== firstRowY) {
			break;
		}

		inferredColumnCount += 1;
	}

	if (inferredColumnCount <= 0) {
		return Math.max(1, fallbackColumnCount);
	}

	return inferredColumnCount;
};

const moveSelectionInGrid = (params: {
	sessions: Session[];
	selectedIndex: number;
	columnCount: number;
	direction: "left" | "right" | "up" | "down";
}): number => {
	const { sessions, selectedIndex, columnCount, direction } = params;

	if (sessions.length === 0) {
		return -1;
	}

	const currentIndex = clampSelection(sessions, selectedIndex);
	const safeColumnCount = Math.max(1, Math.floor(columnCount));

	switch (direction) {
		case "left":
			return Math.max(0, currentIndex - 1);
		case "right":
			return Math.min(sessions.length - 1, currentIndex + 1);
		case "up":
			return currentIndex < safeColumnCount
				? currentIndex
				: currentIndex - safeColumnCount;
		case "down": {
			const nextIndex = currentIndex + safeColumnCount;
			if (nextIndex < sessions.length) {
				return nextIndex;
			}

			const currentColumn = currentIndex % safeColumnCount;
			const lastRowStart = Math.max(
				Math.floor((sessions.length - 1) / safeColumnCount) * safeColumnCount,
				0,
			);
			return Math.min(lastRowStart + currentColumn, sessions.length - 1);
		}
	}
};

const getNextSessionFilterMode = (
	currentMode: SessionFilterMode,
): SessionFilterMode => {
	const currentIndex = SESSION_FILTER_CYCLE.indexOf(currentMode);
	if (currentIndex < 0) {
		return SESSION_FILTER_CYCLE[0];
	}

	return SESSION_FILTER_CYCLE[(currentIndex + 1) % SESSION_FILTER_CYCLE.length];
};

const getNextSessionSortMode = (
	currentMode: SessionSortMode,
): SessionSortMode => {
	const currentIndex = SESSION_SORT_CYCLE.indexOf(currentMode);
	if (currentIndex < 0) {
		return SESSION_SORT_CYCLE[0];
	}

	return SESSION_SORT_CYCLE[(currentIndex + 1) % SESSION_SORT_CYCLE.length];
};

const getNextHierarchyFilterMode = (
	currentMode: HierarchyFilterMode,
): HierarchyFilterMode => {
	const currentIndex = HIERARCHY_FILTER_CYCLE.indexOf(currentMode);
	if (currentIndex < 0) {
		return HIERARCHY_FILTER_CYCLE[0];
	}

	return HIERARCHY_FILTER_CYCLE[
		(currentIndex + 1) % HIERARCHY_FILTER_CYCLE.length
	];
};

const getNextHierarchyViewMode = (
	currentMode: HierarchyViewMode,
): HierarchyViewMode => {
	const currentIndex = HIERARCHY_VIEW_CYCLE.indexOf(currentMode);
	if (currentIndex < 0) {
		return HIERARCHY_VIEW_CYCLE[0];
	}

	return HIERARCHY_VIEW_CYCLE[(currentIndex + 1) % HIERARCHY_VIEW_CYCLE.length];
};

const getNextHierarchyInfoMode = (
	currentMode: HierarchyInfoMode,
): HierarchyInfoMode => {
	const currentIndex = HIERARCHY_INFO_CYCLE.indexOf(currentMode);
	if (currentIndex < 0) {
		return HIERARCHY_INFO_CYCLE[0];
	}

	return HIERARCHY_INFO_CYCLE[(currentIndex + 1) % HIERARCHY_INFO_CYCLE.length];
};

const getSessionFilterLabel = (mode: SessionFilterMode): string => {
	return mode;
};

const getHierarchyFilterLabel = (mode: HierarchyFilterMode): string => {
	return mode === "active" ? "busy" : mode;
};

const footerShortcut = (value: string) => bold(value);

const footerState = (value: string, color: `#${string}` = APP_PALETTE.accent) =>
	fg(color)(value);

const createBannerText = (state: AppState): string => {
	if (state.dbError) {
		return `error: ${state.dbError}`;
	}

	if (state.allSessions.length === 0) {
		const sourceIssueCount = state.sourceIssues.length;
		return sourceIssueCount > 0
			? `sessions: 0 | filter: ${getSessionFilterLabel(state.sessionFilterMode)} | ${sourceIssueCount} source issue${sourceIssueCount === 1 ? "" : "s"}`
			: `sessions: 0 | filter: ${getSessionFilterLabel(state.sessionFilterMode)}`;
	}

	const sourceCounts = countSessionsBySource(state.allSessions);
	const sourceSummary = (["opencode", "codex", "claude"] as const)
		.map((sourceKey) => {
			const count = sourceCounts[sourceKey] ?? 0;
			return count > 0 ? `${getSessionSourceLabel(sourceKey)} ${count}` : null;
		})
		.filter((value): value is string => value !== null)
		.join(" / ");
	const fragments = [`sessions: ${state.allSessions.length}`];
	if (sourceSummary) {
		fragments.push(sourceSummary);
	}

	const sourceIssueCount = state.sourceIssues.length;
	if (sourceIssueCount > 0) {
		fragments.push(
			`${sourceIssueCount} source issue${sourceIssueCount === 1 ? "" : "s"}`,
		);
	}

	const parseIssueCount = Object.keys(state.sessionIssues).length;
	if (parseIssueCount > 0) {
		fragments.push(
			`${parseIssueCount} data issue${parseIssueCount === 1 ? "" : "s"}`,
		);
	}

	return fragments.join(" | ");
};

interface AppState {
	allSessions: Session[];
	sessions: Session[];
	selectedIndex: number;
	selectedSessionId: string | null;
	externalAttachedSessionIds: Set<string>;
	externalAttachedSessionDirectoryCounts: Map<string, number>;
	pendingDeleteSessionId: string | null;
	pendingDeleteSessionTitle: string | null;
	deleteConfirmationError: string | null;
	pendingKillSessionId: string | null;
	pendingKillChildrenCount: number;
	isKillingChildren: boolean;
	killChildrenError: string | null;
	killFallbackRemaining: string[];
	killFallbackConfirmed: string[];
	killFallbackCurrentIndex: number;
	toastMessage: string | null;
	toastTimer: ReturnType<typeof setTimeout> | null;
	renderedDetailSessionId: string | null;
	focusedPane: FocusPane;
	isDetailMode: boolean;
	isSideviewMode: boolean;
	detailReturnToSideview: boolean;
	gridScrollTop: number;
	gridFollowSelectionOnRender: boolean;
	renderedGridColumnCount: number;
	detailScrollTop: number;
	detailScrollTopBySessionId: Partial<Record<string, number>>;
	statusBySessionId: SessionStatusById;
	messageCountBySessionId: Partial<Record<string, number>>;
	sessionIssues: Partial<Record<string, string>>;
	sourceIssues: string[];
	sessionFilterMode: SessionFilterMode;
	sessionSortMode: SessionSortMode;
	hiddenCompletedCount: number;
	isAttachingSession: boolean;
	isDeletingSession: boolean;
	dbError: string | null;
	isHierarchyMode: boolean;
	hierarchyViewMode: HierarchyViewMode;
	hierarchyInfoMode: HierarchyInfoMode;
	hierarchyFilterMode: HierarchyFilterMode;
	hierarchyScrollTop: number;
	hierarchyScrollTopBySessionId: Partial<Record<string, number>>;
	hierarchyOrigin: FocusPane;
	timelineScrollLeft: number;
	timelineScrollLeftBySessionId: Partial<Record<string, number>>;
}

const isScrollBoxRenderable = (
	renderable: Renderable | undefined,
): renderable is ScrollBoxRenderable => {
	return (
		typeof renderable === "object" &&
		renderable !== null &&
		"scrollTo" in renderable &&
		typeof renderable.scrollTo === "function"
	);
};

const isTextRenderable = (
	renderable: Renderable | undefined,
): renderable is TextRenderable => {
	return (
		typeof renderable === "object" &&
		renderable !== null &&
		"content" in renderable
	);
};

const isBoxRenderable = (
	renderable: Renderable | undefined,
): renderable is BoxRenderable => {
	return (
		typeof renderable === "object" &&
		renderable !== null &&
		"backgroundColor" in renderable
	);
};

const clearTerminalScreen = () => {
	try {
		process.stdout.write(CLEAR_TERMINAL_SEQUENCE);
	} catch {}
};

const getAttachDebugPath = (): string | null => {
	const rawPath = process.env.GCTRL_ATTACH_DEBUG?.trim();
	if (!rawPath) {
		return null;
	}

	return rawPath === "1" || rawPath.toLowerCase() === "true"
		? DEFAULT_ATTACH_DEBUG_PATH
		: rawPath;
};

const isAttachDebugEnabled = (): boolean => getAttachDebugPath() !== null;

const isAttachDebugOutputEnabled = (): boolean => {
	const value = process.env.GCTRL_ATTACH_DEBUG_OUTPUT?.trim().toLowerCase();
	return value === "1" || value === "true";
};

const ensurePrivateAttachDebugTarget = (debugPath: string): void => {
	if (debugPath === DEFAULT_ATTACH_DEBUG_PATH) {
		mkdirSync(ATTACH_DEBUG_DIRECTORY, { recursive: true, mode: 0o700 });
		chmodSync(ATTACH_DEBUG_DIRECTORY, 0o700);
	}
};

const writeAttachDebug = (
	event: string,
	details: Record<string, unknown> = {},
): void => {
	const debugPath = getAttachDebugPath();
	if (!debugPath) {
		return;
	}

	try {
		ensurePrivateAttachDebugTarget(debugPath);
		appendFileSync(
			debugPath,
			`${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`,
			{ mode: 0o600 },
		);
		if (debugPath === DEFAULT_ATTACH_DEBUG_PATH) {
			chmodSync(debugPath, 0o600);
		}
	} catch (error) {
		void error;
	}
};

const appendOutputTail = (currentTail: string, chunk: Uint8Array): string => {
	if (!isAttachDebugOutputEnabled()) {
		return currentTail;
	}

	const nextTail = `${currentTail}${new TextDecoder().decode(chunk)}`;
	return nextTail.length > ATTACH_DEBUG_OUTPUT_TAIL_LENGTH
		? nextTail.slice(-ATTACH_DEBUG_OUTPUT_TAIL_LENGTH)
		: nextTail;
};

const getAttachDebugOutputDetails = (
	outputTail: string,
): Record<string, unknown> =>
	isAttachDebugOutputEnabled() ? { outputTail } : {};

const getTerminalColumnCount = (): number =>
	getSafeNumber(process.stdout.columns, 80) || 80;

const getTerminalRowCount = (): number =>
	getSafeNumber(process.stdout.rows, 24) || 24;

const canUseAttachPty = (): boolean =>
	process.platform !== "win32" &&
	process.stdin.isTTY === true &&
	process.stdout.isTTY === true;

const writePtyInput = (terminal: Bun.Terminal, chunk: unknown): void => {
	if (typeof chunk === "string") {
		terminal.write(chunk);
		return;
	}

	if (chunk instanceof Uint8Array) {
		terminal.write(chunk);
	}
};

const setStdinRawMode = (enabled: boolean): boolean => {
	const setRawMode = process.stdin.setRawMode;
	if (typeof setRawMode !== "function") {
		return false;
	}

	try {
		setRawMode.call(process.stdin, enabled);
		return true;
	} catch (error) {
		void error;
		return false;
	}
};

const replaceChildren = (parent: Renderable, children: unknown[]): void => {
	const reusableChildren = new Set(
		children.filter((child): child is Renderable => isRenderable(child)),
	);

	for (const child of [...parent.getChildren()]) {
		if (!reusableChildren.has(child)) {
			child.destroyRecursively();
		}
	}

	for (const child of children) {
		parent.add(child);
	}
};

const createDeleteConfirmationDialog = (params: {
	title: string;
	sessionId: string;
	width: number;
	isDeleting: boolean;
	errorMessage: string | null;
	sourceLabel: string;
}) => {
	const heading = params.isDeleting ? "Deleting session" : "Delete session";
	const body = params.isDeleting
		? `Deleting the selected ${params.sourceLabel} session. Please wait.`
		: `Delete the selected ${params.sourceLabel} session? This cannot be undone.`;
	const hint = params.isDeleting
		? "The session list will refresh automatically when deletion finishes."
		: "Press y to delete. Press Esc or n to cancel.";

	return Box(
		{
			width: params.width,
			border: true,
			borderStyle: "double",
			borderColor: APP_PALETTE.danger,
			backgroundColor: "#160B10",
			padding: 1,
			flexDirection: "column",
			gap: 1,
			onMouseDown: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
			onMouseScroll: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
		},
		Text({
			content: t`${bold(fg(APP_PALETTE.danger)(heading))}`,
			width: "100%",
		}),
		Text({
			content: body,
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${bold(params.title)}`,
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("id ")}${params.sessionId}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "char",
		}),
		...(params.errorMessage
			? [
					Text({
						content: t`${fg(APP_PALETTE.danger)(params.errorMessage)}`,
						width: "100%",
						wrapMode: "word",
					}),
				]
			: []),
		Text({
			content: t`${dim(hint)}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "word",
		}),
	);
};

const createKillChildrenConfirmationDialog = (params: {
	sessionTitle: string;
	sessionId: string;
	childCount: number;
	width: number;
	isKilling: boolean;
	errorMessage: string | null;
}) => {
	const heading = params.isKilling
		? "Aborting child sessions"
		: "Abort child sessions";
	const body = params.isKilling
		? `Aborting ${params.childCount} child session${params.childCount === 1 ? "" : "s"}. Please wait.`
		: `Abort ${params.childCount} active child session${params.childCount === 1 ? "" : "s"}? Sessions will be gracefully stopped via the server when available. Otherwise, sessions will be deleted.`;
	const hint = params.isKilling
		? "The session list will refresh automatically when done."
		: "Press y to abort children. Press Esc or n to cancel.";

	return Box(
		{
			width: params.width,
			border: true,
			borderStyle: "double",
			borderColor: APP_PALETTE.warning,
			backgroundColor: "#16120B",
			padding: 1,
			flexDirection: "column",
			gap: 1,
			onMouseDown: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
			onMouseScroll: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
		},
		Text({
			content: t`${bold(fg(APP_PALETTE.warning)(heading))}`,
			width: "100%",
		}),
		Text({
			content: body,
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${bold(params.sessionTitle)}`,
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("id ")}${params.sessionId}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "char",
		}),
		...(params.errorMessage
			? [
					Text({
						content: t`${fg(APP_PALETTE.danger)(params.errorMessage)}`,
						width: "100%",
						wrapMode: "word",
					}),
				]
			: []),
		Text({
			content: t`${dim(hint)}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "word",
		}),
	);
};

const createKillFallbackDialog = (params: {
	childId: string;
	childTitle: string;
	currentIndex: number;
	totalCount: number;
	confirmedCount: number;
	width: number;
}) => {
	return Box(
		{
			width: params.width,
			border: true,
			borderStyle: "double",
			borderColor: APP_PALETTE.danger,
			backgroundColor: "#160B10",
			padding: 1,
			flexDirection: "column",
			gap: 1,
			onMouseDown: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
			onMouseScroll: (event) => {
				event.preventDefault();
				event.stopPropagation();
			},
		},
		Text({
			content: t`${bold(fg(APP_PALETTE.danger)(`Delete child session (${params.currentIndex}/${params.totalCount})?`))}`,
			width: "100%",
		}),
		Text({
			content:
				"Graceful stop failed. This will permanently delete the session.",
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${bold(params.childTitle)}`,
			fg: APP_PALETTE.text,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("id ")}${params.childId}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "char",
		}),
		Box({ height: 1 }),
		Text({
			content: t`${dim("Progress: ")}${fg(APP_PALETTE.accent)(`${params.confirmedCount} confirmed`)}${dim(", ")}${fg(APP_PALETTE.muted)(`${params.currentIndex - params.confirmedCount} skipped`)}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("y")}${bold(fg(APP_PALETTE.danger)(": delete"))}${dim(" | ")}${dim("n")}${bold(": skip")}${dim(" | ")}${dim("Esc/q")}${bold(": cancel all")}`,
			fg: APP_PALETTE.muted,
			width: "100%",
			wrapMode: "word",
		}),
	);
};

const pruneSessionScopedNumberState = (
	stateBySessionId: Partial<Record<string, number>>,
	sessions: Session[],
): Partial<Record<string, number>> => {
	const activeSessionIds = new Set(sessions.map((session) => session.id));

	return Object.fromEntries(
		Object.entries(stateBySessionId).filter(([sessionId]) =>
			activeSessionIds.has(sessionId),
		),
	);
};

const getSelectionAwareGridScrollTop = (params: {
	currentScrollTop: number;
	gridHeight: number;
	columnCount: number;
	selectedIndex: number;
	sessionCount: number;
}): number => {
	const {
		currentScrollTop,
		gridHeight,
		columnCount,
		selectedIndex,
		sessionCount,
	} = params;

	if (sessionCount === 0 || selectedIndex < 0) {
		return 0;
	}

	if (selectedIndex === 0) {
		return 0;
	}

	const safeColumnCount = Math.max(1, Math.floor(columnCount));
	const selectedRow = Math.floor(selectedIndex / safeColumnCount);
	const rowStride = SESSION_CARD_MAX_HEIGHT + SESSION_GRID_ROW_GAP;
	const visibleRowCount = getGridVisibleRowCount(gridHeight);
	const currentTopRow = Math.max(Math.floor(currentScrollTop / rowStride), 0);
	const currentBottomRow = currentTopRow + visibleRowCount - 1;

	if (selectedRow < currentTopRow) {
		return selectedRow * rowStride;
	}

	if (selectedRow > currentBottomRow) {
		return Math.max(0, (selectedRow - visibleRowCount + 1) * rowStride);
	}

	return Math.max(currentScrollTop, 0);
};

const getSelectedIndexById = (
	sessions: Session[],
	selectedSessionId: string | null,
	fallbackIndex: number,
): number => {
	if (sessions.length === 0) {
		return -1;
	}

	if (selectedSessionId) {
		const matchedIndex = sessions.findIndex(
			(session) => session.id === selectedSessionId,
		);

		if (matchedIndex >= 0) {
			return matchedIndex;
		}
	}

	return clampSelection(sessions, fallbackIndex);
};

const getFocusedPane = (
	showGrid: boolean,
	showDetail: boolean,
	currentFocus: FocusPane,
): FocusPane => {
	if (showDetail && !showGrid) {
		return "detail";
	}

	if (showGrid && !showDetail) {
		return "grid";
	}

	return currentFocus;
};

const matchesPhysicalKey = (
	key: KeyEvent,
	options: {
		names?: string[];
		codes?: string[];
		sequences?: string[];
	},
): boolean => {
	const normalizedName = key.name.toLowerCase();
	const normalizedCode = key.code?.toLowerCase();
	const normalizedSequence = key.sequence.toLowerCase();

	if (options.codes?.some((code) => code.toLowerCase() === normalizedCode)) {
		return true;
	}

	if (options.names?.some((name) => name.toLowerCase() === normalizedName)) {
		return true;
	}

	if (
		options.sequences?.some(
			(sequence) => sequence.toLowerCase() === normalizedSequence,
		)
	) {
		return true;
	}

	return false;
};

const isSideviewShortcut = (key: KeyEvent): boolean => {
	return matchesPhysicalKey(key, {
		names: ["e", "p"],
		codes: ["keye", "keyp"],
		sequences: ["e", "p"],
	});
};

const main = async () => {
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		useMouse: true,
		useKittyKeyboard: {
			disambiguate: true,
			alternateKeys: true,
		},
	});

	const state: AppState = {
		allSessions: [],
		sessions: [],
		selectedIndex: -1,
		selectedSessionId: null,
		externalAttachedSessionIds: new Set(),
		externalAttachedSessionDirectoryCounts: new Map(),
		pendingDeleteSessionId: null,
		pendingDeleteSessionTitle: null,
		deleteConfirmationError: null,
		pendingKillSessionId: null,
		pendingKillChildrenCount: 0,
		isKillingChildren: false,
		killChildrenError: null,
		killFallbackRemaining: [],
		killFallbackConfirmed: [],
		killFallbackCurrentIndex: 0,
		toastMessage: null,
		toastTimer: null,
		renderedDetailSessionId: null,
		focusedPane: "grid",
		isDetailMode: false,
		isSideviewMode: false,
		detailReturnToSideview: false,
		gridScrollTop: 0,
		gridFollowSelectionOnRender: false,
		renderedGridColumnCount: 1,
		detailScrollTop: 0,
		detailScrollTopBySessionId: {},
		statusBySessionId: {},
		messageCountBySessionId: {},
		sessionIssues: {},
		sourceIssues: [],
		sessionFilterMode: "active",
		sessionSortMode: "status",
		hiddenCompletedCount: 0,
		isAttachingSession: false,
		isDeletingSession: false,
		dbError: null,
		isHierarchyMode: false,
		hierarchyViewMode: "tree",
		hierarchyInfoMode: "standard",
		hierarchyFilterMode: "all",
		hierarchyScrollTop: 0,
		hierarchyScrollTopBySessionId: {},
		hierarchyOrigin: "grid",
		timelineScrollLeft: 0,
		timelineScrollLeftBySessionId: {},
	};

	const refreshCoordinator = createRefreshCoordinator();
	const workerExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const refreshWorker = new Worker(
		new URL(`./db/refresh-worker${workerExtension}`, import.meta.url).href,
		{ smol: true },
	);
	(refreshWorker as Worker & { unref(): void }).unref();
	const isResizeDebouncing: { value: ReturnType<typeof setTimeout> | null } = {
		value: null,
	};
	let interval: ReturnType<typeof setInterval> | null = null;
	let isWaitingPulseLive = false;
	let lastWaitingPulseFrameRenderAt = 0;
	let isRefreshApplying = false;
	let isRefreshingExternalAttachedSessions = false;
	let pendingSelectionRefreshResponse: RefreshResponse | null = null;
	let pendingSelectionRender = false;
	let selectionCopyTimer: ReturnType<typeof setTimeout> | null = null;

	const renderStatsPath = process.env.GCTRL_RENDER_STATS || "";
	const renderStats = renderStatsPath
		? {
				applyTriggeredRenders: 0,
				liveFrameRenders: 0,
				liveFrameSkippedDuringApply: 0,
			}
		: null;

	const areSessionIdSetsEqual = (
		left: ReadonlySet<string>,
		right: ReadonlySet<string>,
	): boolean => {
		if (left.size !== right.size) {
			return false;
		}

		for (const sessionId of left) {
			if (!right.has(sessionId)) {
				return false;
			}
		}

		return true;
	};

	const areDirectoryCountMapsEqual = (
		left: ReadonlyMap<string, number>,
		right: ReadonlyMap<string, number>,
	): boolean => {
		if (left.size !== right.size) {
			return false;
		}

		for (const [directory, count] of left) {
			if ((right.get(directory) ?? 0) !== count) {
				return false;
			}
		}

		return true;
	};

	const getSubprocessStreamText = (stream: unknown): Promise<string> => {
		if (stream instanceof ReadableStream) {
			return new Response(stream as ReadableStream<Uint8Array>).text();
		}

		return Promise.resolve("");
	};

	const readAttachedSessionSignalsFromProcessList = async (): Promise<{
		sessionIds: Set<string>;
		directoryProcessCounts: Map<string, number>;
	}> => {
		if (process.platform === "win32") {
			return {
				sessionIds: new Set(),
				directoryProcessCounts: new Map(),
			};
		}

		let child: ReturnType<typeof Bun.spawn>;
		try {
			child = Bun.spawn({
				cmd: ["ps", "-eo", "pid,comm,args"],
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch {
			return {
				sessionIds: new Set(),
				directoryProcessCounts: new Map(),
			};
		}

		const stdoutTextPromise = getSubprocessStreamText(child.stdout);
		const [stdoutText, exitCode] = await Promise.all([
			stdoutTextPromise,
			child.exited,
		]);

		if (exitCode !== 0) {
			return {
				sessionIds: new Set(),
				directoryProcessCounts: new Map(),
			};
		}

		return parseAttachedSessionIdsFromProcessList(stdoutText, (pid) => {
			try {
				return normalizeDirectoryPath(readlinkSync(`/proc/${pid}/cwd`));
			} catch {
				return null;
			}
		});
	};

	const runAttachedSession = async (
		attachLaunchSpec: NonNullable<ReturnType<typeof getAttachLaunchSpec>>,
	): Promise<number> => {
		const useAttachPty = canUseAttachPty();
		const attachEnvironment = getAttachLaunchEnvironment(attachLaunchSpec);
		writeAttachDebug("run:start", {
			cmd: attachLaunchSpec.cmd,
			cwd: attachLaunchSpec.cwd,
			path: attachEnvironment.PATH,
			stdinTTY: process.stdin.isTTY,
			stdoutTTY: process.stdout.isTTY,
			platform: process.platform,
			useAttachPty,
		});

		if (!useAttachPty) {
			const child = Bun.spawn({
				cmd: attachLaunchSpec.cmd,
				cwd: attachLaunchSpec.cwd,
				env: attachEnvironment,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			writeAttachDebug("run:spawn", { pid: child.pid, mode: "inherit" });

			const exitCode = await child.exited;
			writeAttachDebug("run:exit", { exitCode, mode: "inherit" });
			return exitCode;
		}

		let outputTail = "";
		const terminal = new Bun.Terminal({
			cols: getTerminalColumnCount(),
			rows: getTerminalRowCount(),
			data: (_terminal, data) => {
				outputTail = appendOutputTail(outputTail, data);
				process.stdout.write(data);
			},
			exit: (_terminal, exitCode, signalCode) => {
				writeAttachDebug("run:terminal-exit", {
					exitCode,
					signalCode,
					...getAttachDebugOutputDetails(outputTail),
				});
			},
		});
		const forwardStdin = (chunk: unknown) => writePtyInput(terminal, chunk);
		const resizeTerminal = () => {
			terminal.resize(getTerminalColumnCount(), getTerminalRowCount());
		};

		process.stdin.on("data", forwardStdin);
		process.stdin.resume();
		process.on("SIGWINCH", resizeTerminal);
		const restoredRawMode = setStdinRawMode(true);
		writeAttachDebug("run:pty-ready", { restoredRawMode });

		try {
			const child = Bun.spawn({
				cmd: attachLaunchSpec.cmd,
				cwd: attachLaunchSpec.cwd,
				env: attachEnvironment,
				terminal,
			});
			writeAttachDebug("run:spawn", { pid: child.pid, mode: "pty" });

			const exitCode = await child.exited;
			writeAttachDebug("run:exit", {
				exitCode,
				mode: "pty",
				...getAttachDebugOutputDetails(outputTail),
			});
			return exitCode;
		} finally {
			writeAttachDebug("run:cleanup", { restoredRawMode });
			if (restoredRawMode) {
				setStdinRawMode(false);
			}
			process.stdin.off("data", forwardStdin);
			process.off("SIGWINCH", resizeTerminal);
			try {
				terminal.close();
			} catch (error) {
				void error;
			}
		}
	};

	const refreshExternalAttachedSessionSignals = async () => {
		if (isRefreshingExternalAttachedSessions) {
			return;
		}

		isRefreshingExternalAttachedSessions = true;
		try {
			const nextAttachedSessionSignals =
				await readAttachedSessionSignalsFromProcessList();
			const areAttachedSessionIdsEqual = areSessionIdSetsEqual(
				state.externalAttachedSessionIds,
				nextAttachedSessionSignals.sessionIds,
			);
			const areAttachedDirectoryCountsEqual = areDirectoryCountMapsEqual(
				state.externalAttachedSessionDirectoryCounts,
				nextAttachedSessionSignals.directoryProcessCounts,
			);
			if (areAttachedSessionIdsEqual && areAttachedDirectoryCountsEqual) {
				return;
			}

			state.externalAttachedSessionIds = nextAttachedSessionSignals.sessionIds;
			state.externalAttachedSessionDirectoryCounts =
				nextAttachedSessionSignals.directoryProcessCounts;
			refreshSessions();
		} finally {
			isRefreshingExternalAttachedSessions = false;
		}
	};

	const getStateForSession = (
		sessionId?: string,
	): { summary?: string; status?: SessionStatus } => {
		if (!sessionId) {
			return {};
		}

		const session = state.allSessions.find(
			(candidate) => candidate.id === sessionId,
		);
		const summaryFragments = [
			sanitizeText(session?.statusDetail, ""),
			sanitizeText(state.sessionIssues[sessionId], ""),
		].filter((fragment) => fragment.length > 0);

		return {
			summary:
				summaryFragments.length > 0 ? summaryFragments.join(" · ") : undefined,
			status: state.statusBySessionId[sessionId],
		};
	};

	const syncWaitingPulseRendering = (isGridVisible: boolean) => {
		const shouldPulse =
			isGridVisible &&
			!state.isAttachingSession &&
			state.sessions.some(
				(session) => session.status === SessionStatus.waiting,
			);

		if (shouldPulse && !isWaitingPulseLive) {
			renderer.requestLive();
			isWaitingPulseLive = true;
			lastWaitingPulseFrameRenderAt = 0;
			return;
		}

		if (!shouldPulse && isWaitingPulseLive) {
			renderer.dropLive();
			isWaitingPulseLive = false;
			lastWaitingPulseFrameRenderAt = 0;
		}
	};

	const setFocusedPane = (pane: FocusPane) => {
		if (state.focusedPane === pane) {
			return;
		}

		state.focusedPane = pane;
		render();
	};

	const handlePaneMouseScroll = (
		pane: FocusPane,
		direction?: "up" | "down" | "left" | "right",
	) => {
		if (direction !== "up" && direction !== "down") {
			return;
		}

		const delta = direction === "up" ? -DETAIL_SCROLL_STEP : DETAIL_SCROLL_STEP;

		setFocusedPane(pane);

		if (pane === "detail") {
			scrollDetail(delta);
			return;
		}

		const gridScrollBox = renderer.root.findDescendantById(GRID_SCROLLBOX_ID);
		if (!isScrollBoxRenderable(gridScrollBox) || !gridScrollBox.visible) {
			return;
		}

		gridScrollBox.scrollBy({ x: 0, y: delta });
		state.gridScrollTop = gridScrollBox.scrollTop;
	};

	const stopPolling = () => {
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
	};

	const startPolling = () => {
		if (!interval) {
			interval = setInterval(() => {
				void refreshExternalAttachedSessionSignals();
				refreshSessions();
			}, POLL_INTERVAL_MS);
		}
	};

	const createStaticLayout = () => {
		renderer.root.add(
			Box(
				{
					id: APP_ROOT_ID,
					width: "100%",
					height: "100%",
					flexDirection: "column",
					gap: 1,
					backgroundColor: APP_PALETTE.bg,
				},
				Box(
					{
						id: CONTENT_CONTAINER_ID,
						width: "100%",
						height: "100%",
						flexDirection: "row",
						gap: 1,
					},
					ScrollBox(
						{
							id: GRID_SCROLLBOX_ID,
							width: "100%",
							height: "100%",
							border: true,
							borderColor: "#334155",
							backgroundColor: "#020617",
							paddingTop: 1,
							paddingBottom: 1,
							paddingLeft: 1,
							paddingRight: 0,
							onMouseDown: (event) => {
								event.preventDefault();
								event.stopPropagation();
								setFocusedPane("grid");
							},
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								handlePaneMouseScroll("grid", event.scroll?.direction);
							},
						},
						Box({
							id: GRID_CONTENT_ID,
							width: "100%",
							flexDirection: "column",
						}),
					),
					ScrollBox(
						{
							id: DETAIL_SCROLLBOX_ID,
							width: 0,
							height: "100%",
							border: true,
							borderColor: "#334155",
							backgroundColor: "#0F172A",
							padding: 1,
							visible: false,
							onMouseDown: (event) => {
								event.preventDefault();
								event.stopPropagation();
								setFocusedPane("detail");
								if (
									event.button === MouseButton.RIGHT &&
									state.isDetailMode &&
									!state.isSideviewMode
								) {
									event.preventDefault();
									closeDetailView();
								}
							},
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								handlePaneMouseScroll("detail", event.scroll?.direction);
							},
						},
						Box({
							id: DETAIL_CONTENT_ID,
							width: "100%",
							flexDirection: "column",
						}),
					),
					Box(
						{
							id: HIERARCHY_CONTAINER_ID,
							width: 0,
							height: "100%",
							border: true,
							borderColor: "#334155",
							backgroundColor: "#0F172A",
							flexDirection: "column",
							visible: false,
							onMouseDown: (event) => {
								event.preventDefault();
								event.stopPropagation();
							},
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								const direction = event.scroll?.direction;
								if (direction === "up" || direction === "down") {
									scrollHierarchy(
										direction === "up"
											? -DETAIL_SCROLL_STEP
											: DETAIL_SCROLL_STEP,
									);
									return;
								}

								if (getEffectiveHierarchyViewMode() === "flow") {
									if (direction === "left") {
										scrollTimeline(-TIMELINE_SCROLL_STEP);
										return;
									}

									if (direction === "right") {
										scrollTimeline(TIMELINE_SCROLL_STEP);
									}
								}
							},
						},
						Box({
							id: HIERARCHY_HEADER_ID,
							width: "100%",
							padding: 1,
							visible: false,
							onMouseDown: (event) => {
								event.preventDefault();
								event.stopPropagation();
							},
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								const direction = event.scroll?.direction;
								if (direction === "up" || direction === "down") {
									scrollHierarchy(
										direction === "up"
											? -DETAIL_SCROLL_STEP
											: DETAIL_SCROLL_STEP,
									);
									return;
								}

								if (getEffectiveHierarchyViewMode() === "flow") {
									if (direction === "left") {
										scrollTimeline(-TIMELINE_SCROLL_STEP);
										return;
									}

									if (direction === "right") {
										scrollTimeline(TIMELINE_SCROLL_STEP);
									}
								}
							},
						}),
						Box({
							id: HIERARCHY_TIMELINE_ANCHOR_ID,
							width: "100%",
							paddingLeft: 1,
							paddingRight: 1,
							visible: false,
							onMouseDown: (event) => {
								event.preventDefault();
								event.stopPropagation();
							},
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								const direction = event.scroll?.direction;
								if (direction === "up" || direction === "down") {
									scrollHierarchy(
										direction === "up"
											? -DETAIL_SCROLL_STEP
											: DETAIL_SCROLL_STEP,
									);
									return;
								}

								if (getEffectiveHierarchyViewMode() === "flow") {
									if (direction === "left") {
										scrollTimeline(-TIMELINE_SCROLL_STEP);
										return;
									}

									if (direction === "right") {
										scrollTimeline(TIMELINE_SCROLL_STEP);
									}
								}
							},
						}),
						ScrollBox(
							{
								id: HIERARCHY_SCROLLBOX_ID,
								width: "100%",
								height: "100%",
								backgroundColor: "#0F172A",
								padding: 1,
								visible: false,
								onMouseDown: (event) => {
									event.preventDefault();
									event.stopPropagation();
								},
								onMouseScroll: (event) => {
									event.preventDefault();
									event.stopPropagation();
									const direction = event.scroll?.direction;
									if (direction === "up" || direction === "down") {
										scrollHierarchy(
											direction === "up"
												? -DETAIL_SCROLL_STEP
												: DETAIL_SCROLL_STEP,
										);
										return;
									}

									if (getEffectiveHierarchyViewMode() === "flow") {
										if (direction === "left") {
											scrollTimeline(-TIMELINE_SCROLL_STEP);
											return;
										}

										if (direction === "right") {
											scrollTimeline(TIMELINE_SCROLL_STEP);
										}
									}
								},
							},
							Box({
								id: HIERARCHY_CONTENT_ID,
								width: "100%",
								flexDirection: "column",
							}),
						),
					),
				),
				Box(
					{
						id: FOOTER_CONTAINER_ID,
						width: "100%",
						flexDirection: "column",
						gap: 0,
						alignItems: "stretch",
						justifyContent: "flex-start",
					},
					Text({ id: STATUS_TEXT_ID, width: "100%" }),
					Text({
						id: CONTROL_TEXT_ID,
						width: "100%",
						onMouseDown: (event) => {
							if (event.button !== MouseButton.LEFT || event.isDragging) {
								return;
							}

							event.preventDefault();
							event.stopPropagation();
							cycleSessionFilterMode();
						},
					}),
				),
			),
		);

		renderer.root.add(
			Box({
				id: DELETE_CONFIRMATION_OVERLAY_ID,
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 50,
				backgroundColor: "#020617",
				opacity: 0.96,
				alignItems: "center",
				justifyContent: "center",
				visible: false,
				onMouseDown: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onMouseScroll: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
			}),
		);

		renderer.root.add(
			Box({
				id: TOAST_OVERLAY_ID,
				position: "absolute",
				bottom: 3,
				right: 2,
				zIndex: 60,
				visible: false,
				paddingLeft: 1,
				paddingRight: 1,
				backgroundColor: "#1e293b",
				border: true,
				borderColor: "#334155",
			}),
		);
	};

	const render = () => {
		if (hasActiveTextSelection()) {
			pendingSelectionRender = true;
			return;
		}

		pendingSelectionRender = false;

		const existingRoot = renderer.root.findDescendantById(APP_ROOT_ID);
		const existingGridScrollBox =
			renderer.root.findDescendantById(GRID_SCROLLBOX_ID);
		const existingDetailScrollBox =
			renderer.root.findDescendantById(DETAIL_SCROLLBOX_ID);
		const existingHierarchyContainer = renderer.root.findDescendantById(
			HIERARCHY_CONTAINER_ID,
		);
		const existingHierarchyHeader =
			renderer.root.findDescendantById(HIERARCHY_HEADER_ID);
		const existingHierarchyTimelineAnchor = renderer.root.findDescendantById(
			HIERARCHY_TIMELINE_ANCHOR_ID,
		);
		const footerContainer =
			renderer.root.findDescendantById(FOOTER_CONTAINER_ID);
		const statusText = renderer.root.findDescendantById(STATUS_TEXT_ID);
		const controlText = renderer.root.findDescendantById(CONTROL_TEXT_ID);
		const contentContainer =
			renderer.root.findDescendantById(CONTENT_CONTAINER_ID);
		const gridContent = renderer.root.findDescendantById(GRID_CONTENT_ID);
		const detailContent = renderer.root.findDescendantById(DETAIL_CONTENT_ID);
		const existingHierarchyScrollBox = renderer.root.findDescendantById(
			HIERARCHY_SCROLLBOX_ID,
		);
		const hierarchyContent =
			renderer.root.findDescendantById(HIERARCHY_CONTENT_ID);
		const deleteConfirmationOverlay = renderer.root.findDescendantById(
			DELETE_CONFIRMATION_OVERLAY_ID,
		);
		const activeDetailSessionId = state.renderedDetailSessionId;

		if (
			!isBoxRenderable(existingRoot) ||
			!isScrollBoxRenderable(existingGridScrollBox) ||
			!isScrollBoxRenderable(existingDetailScrollBox) ||
			!isBoxRenderable(existingHierarchyContainer) ||
			!isBoxRenderable(existingHierarchyHeader) ||
			!isBoxRenderable(existingHierarchyTimelineAnchor) ||
			!isScrollBoxRenderable(existingHierarchyScrollBox) ||
			!isBoxRenderable(footerContainer) ||
			!isTextRenderable(statusText) ||
			!isTextRenderable(controlText) ||
			!isBoxRenderable(contentContainer) ||
			!isBoxRenderable(gridContent) ||
			!isBoxRenderable(detailContent) ||
			!isBoxRenderable(hierarchyContent) ||
			!isBoxRenderable(deleteConfirmationOverlay)
		) {
			return;
		}

		state.gridScrollTop = existingGridScrollBox.scrollTop;

		if (existingDetailScrollBox.visible) {
			state.detailScrollTop = existingDetailScrollBox.scrollTop;
			if (activeDetailSessionId) {
				state.detailScrollTopBySessionId[activeDetailSessionId] =
					existingDetailScrollBox.scrollTop;
			}
		}

		if (existingHierarchyScrollBox.visible) {
			state.hierarchyScrollTop = existingHierarchyScrollBox.scrollTop;
			if (state.selectedSessionId) {
				state.hierarchyScrollTopBySessionId[state.selectedSessionId] =
					existingHierarchyScrollBox.scrollTop;
			}
		}

		const width = getSafeNumber(renderer.width, 80);
		const height = getSafeNumber(renderer.height, 24);
		const innerWidth = Math.max(width - ROOT_PADDING_X, 1);

		const headerText = createBannerText(state);
		const detailWidth = Math.max(Math.floor(innerWidth * 0.34), 22);
		const gridWidth = getGridWidth(innerWidth, state.isSideviewMode);
		const detailOnlyMode = state.isDetailMode && !state.isSideviewMode;
		const showGrid = !detailOnlyMode && !state.isHierarchyMode;
		const showDetail =
			(state.isSideviewMode || detailOnlyMode) && !state.isHierarchyMode;
		const showHierarchy = state.isHierarchyMode;
		const gridVerticalScrollbarInset =
			showGrid && existingGridScrollBox.verticalScrollBar.visible
				? Math.max(
						getSafeNumber(existingGridScrollBox.verticalScrollBar.width, 1),
						1,
					)
				: 0;
		const gridLayoutWidth = Math.max(gridWidth - gridVerticalScrollbarInset, 1);
		const fallbackGridColumnCount = Math.max(
			1,
			getGridColumnCount(gridLayoutWidth),
		);
		state.renderedGridColumnCount = getRenderedGridColumnCount(
			gridContent,
			fallbackGridColumnCount,
		);
		const canSwitchFocus = showGrid && showDetail;
		const deletePromptActive = Boolean(
			state.pendingDeleteSessionId || state.pendingKillSessionId,
		);
		state.focusedPane = getFocusedPane(showGrid, showDetail, state.focusedPane);
		const hierarchyNarrowMode =
			showHierarchy && isHierarchyNarrowMode(innerWidth);
		const effectiveHierarchyViewMode = showHierarchy
			? getEffectiveHierarchyViewMode(innerWidth)
			: state.hierarchyViewMode;
		const focusLabel = state.focusedPane === "detail" ? "detail" : "grid";
		const focusSummary = canSwitchFocus
			? `${headerText} | sort: ${state.sessionSortMode} | focus: ${focusLabel}`
			: headerText;
		const shortcutPrefix = canSwitchFocus ? "Tab: switch pane | " : "";
		const sessionFilterLabel = getSessionFilterLabel(state.sessionFilterMode);
		const shouldShowHiddenCompleted =
			state.sessionFilterMode === "active" ||
			state.sessionFilterMode === "recent";
		const hiddenCompletedSummary =
			shouldShowHiddenCompleted && state.hiddenCompletedCount > 0
				? ` | hidden completed: ${state.hiddenCompletedCount}`
				: "";
		const hierarchyViewLabel =
			effectiveHierarchyViewMode === "flow" ? "timeline" : "tree";
		const hierarchyFilterLabel = getHierarchyFilterLabel(
			state.hierarchyFilterMode,
		);
		const hierarchyScrollHint =
			effectiveHierarchyViewMode === "flow"
				? "↑/↓: scroll | ←/→: pan timeline"
				: "↑/↓: scroll";
		const selectedSessionForActions =
			state.sessions[state.selectedIndex] ?? null;
		const canAttachSelected = canAttachToSession(selectedSessionForActions);
		const canDeleteSelected = canDeleteSession(selectedSessionForActions);
		const canAbortChildrenSelected =
			(state.isDetailMode || state.isSideviewMode) &&
			canAbortSessionChildren(selectedSessionForActions);
		const shortcutGuide = deletePromptActive
			? state.pendingDeleteSessionId
				? state.isDeletingSession
					? "Deleting selected session..."
					: "Delete selected session? y: confirm | Esc/n: cancel"
				: state.isKillingChildren
					? "Deleting confirmed sessions..."
					: state.killFallbackRemaining.length > 0
						? "Delete child? y: delete | n: skip | Esc: cancel all"
						: "Abort child sessions? y: confirm | Esc/n: cancel"
			: state.isHierarchyMode
				? `Tab: view(${hierarchyViewLabel}) | x: info(${state.hierarchyInfoMode}) | f: filter(${hierarchyFilterLabel}) | ${hierarchyScrollHint} | q/Esc: close`
				: state.focusedPane === "detail"
					? `${FILTER_SHORTCUT_LABEL}/click: filter(${sessionFilterLabel}) | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}${TIMELINE_SHORTCUT_LABEL}: timeline | ↑/↓: scroll detail | ${HIERARCHY_SHORTCUT_LABEL}: hierarchy${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: abort children` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""} | ${COPY_ID_SHORTCUT_LABEL}: copy id${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""} | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | q/Esc: quit`
					: `${FILTER_SHORTCUT_LABEL}/click: filter(${sessionFilterLabel}) | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}arrows: move grid | Enter: detail | ${TIMELINE_SHORTCUT_LABEL}: timeline | ${HIERARCHY_SHORTCUT_LABEL}: hierarchy${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: abort children` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""} | ${COPY_ID_SHORTCUT_LABEL}: copy id${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""} | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | q/Esc: quit`;
		const styledShortcutGuide = deletePromptActive
			? state.pendingDeleteSessionId
				? state.isDeletingSession
					? t`${fg(APP_PALETTE.warning)("Deleting selected session...")}`
					: t`${fg(APP_PALETTE.danger)("Delete selected session? ")}${footerShortcut("y")}${dim(": confirm | ")}${footerShortcut("Esc/n")}${dim(": cancel")}`
				: state.isKillingChildren
					? t`${fg(APP_PALETTE.warning)("Deleting confirmed sessions...")}`
					: state.killFallbackRemaining.length > 0
						? t`${fg(APP_PALETTE.danger)("Delete child? ")}${footerShortcut("y")}${dim(": delete | ")}${footerShortcut("n")}${dim(": skip | ")}${footerShortcut("Esc")}${dim(": cancel all")}`
						: t`${fg(APP_PALETTE.warning)("Abort child sessions? ")}${footerShortcut("y")}${dim(": confirm | ")}${footerShortcut("Esc/n")}${dim(": cancel")}`
			: state.isHierarchyMode
				? effectiveHierarchyViewMode === "flow"
					? t`${footerShortcut("Tab")}${dim(": view(")}${footerState(hierarchyViewLabel)}${dim(") | ")}${footerShortcut("x")}${dim(": info(")}${footerState(state.hierarchyInfoMode)}${dim(") | ")}${footerShortcut("f")}${dim(": filter(")}${footerState(hierarchyFilterLabel)}${dim(") | ")}${footerShortcut("↑/↓")}${dim(": scroll | ")}${footerShortcut("←/→")}${dim(": pan timeline | ")}${footerShortcut("q/Esc")}${dim(": close")}`
					: t`${footerShortcut("Tab")}${dim(": view(")}${footerState(hierarchyViewLabel)}${dim(") | ")}${footerShortcut("x")}${dim(": info(")}${footerState(state.hierarchyInfoMode)}${dim(") | ")}${footerShortcut("f")}${dim(": filter(")}${footerState(hierarchyFilterLabel)}${dim(") | ")}${footerShortcut("↑/↓")}${dim(": scroll | ")}${footerShortcut("q/Esc")}${dim(": close")}`
				: state.focusedPane === "detail"
					? t`${footerShortcut(FILTER_SHORTCUT_LABEL)}${dim("/click: filter(")}${footerState(sessionFilterLabel)}${dim(") | ")}${footerShortcut(SORT_SHORTCUT_LABEL)}${dim(": sort(")}${footerState(state.sessionSortMode)}${dim(") | ")}${canSwitchFocus ? footerShortcut("Tab") : ""}${canSwitchFocus ? dim(": switch pane | ") : ""}${footerShortcut(TIMELINE_SHORTCUT_LABEL)}${dim(": timeline | ")}${footerShortcut("↑/↓")}${dim(": scroll detail | ")}${footerShortcut(HIERARCHY_SHORTCUT_LABEL)}${dim(": hierarchy")}${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: abort children` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""}${dim(" | ")}${footerShortcut(COPY_ID_SHORTCUT_LABEL)}${dim(": copy id")}${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""}${dim(" | ")}${footerShortcut(SIDEVIEW_SHORTCUT_LABEL)}${dim(": sideview | ")}${footerShortcut("q/Esc")}${dim(": quit")}`
					: t`${footerShortcut(FILTER_SHORTCUT_LABEL)}${dim("/click: filter(")}${footerState(sessionFilterLabel)}${dim(") | ")}${footerShortcut(SORT_SHORTCUT_LABEL)}${dim(": sort(")}${footerState(state.sessionSortMode)}${dim(") | ")}${canSwitchFocus ? footerShortcut("Tab") : ""}${canSwitchFocus ? dim(": switch pane | ") : ""}${footerShortcut("arrows")}${dim(": move grid | ")}${footerShortcut("Enter")}${dim(": detail | ")}${footerShortcut(TIMELINE_SHORTCUT_LABEL)}${dim(": timeline | ")}${footerShortcut(HIERARCHY_SHORTCUT_LABEL)}${dim(": hierarchy")}${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: abort children` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""}${dim(" | ")}${footerShortcut(COPY_ID_SHORTCUT_LABEL)}${dim(": copy id")}${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""}${dim(" | ")}${footerShortcut(SIDEVIEW_SHORTCUT_LABEL)}${dim(": sideview | ")}${footerShortcut("q/Esc")}${dim(": quit")}`;
		const footerAvailableWidth = innerWidth;
		const footerWraps =
			shortcutGuide.length + focusSummary.length + FOOTER_INLINE_GAP >
			footerAvailableWidth;
		const footerHeight = footerWraps ? 2 : 1;
		const contentHeight = Math.max(
			height - ROOT_PADDING_TOP - ROOT_CONTENT_GAP - footerHeight,
			1,
		);
		if (state.gridFollowSelectionOnRender) {
			state.gridScrollTop = getSelectionAwareGridScrollTop({
				currentScrollTop: state.gridScrollTop,
				gridHeight: contentHeight,
				columnCount: Math.max(
					1,
					state.renderedGridColumnCount || fallbackGridColumnCount,
				),
				selectedIndex: state.selectedIndex,
				sessionCount: state.sessions.length,
			});
		}
		state.gridScrollTop = clampGridScrollTop({
			currentScrollTop: state.gridScrollTop,
			gridHeight: contentHeight,
			columnCount: Math.max(
				1,
				state.renderedGridColumnCount || fallbackGridColumnCount,
			),
			sessionCount: state.sessions.length,
		});

		const selectedSession = state.sessions[state.selectedIndex] ?? null;
		const nextDetailScrollTop = selectedSession?.id
			? (state.detailScrollTopBySessionId[selectedSession.id] ?? 0)
			: 0;
		const selectedState = getStateForSession(selectedSession?.id);
		const shouldRestoreDetailScroll =
			showDetail && selectedSession?.id !== state.renderedDetailSessionId;

		if (showHierarchy && selectedSession?.id) {
			state.timelineScrollLeft =
				state.timelineScrollLeftBySessionId[selectedSession.id] ?? 0;
		}

		const timelineViewportWidth = getTimelineViewportWidth(
			showHierarchy ? innerWidth : undefined,
		);

		existingRoot.width = width;
		existingRoot.height = height;
		existingRoot.flexDirection = "column";
		existingRoot.paddingTop = ROOT_PADDING_TOP;
		existingRoot.paddingRight = 1;
		existingRoot.paddingLeft = 1;
		existingRoot.paddingBottom = 0;
		existingRoot.gap = 1;
		existingRoot.backgroundColor = APP_PALETTE.bg;

		const rightFooterText =
			state.dbError ??
			(state.pendingKillSessionId
				? state.isKillingChildren
					? "deleting sessions..."
					: state.killFallbackRemaining.length > 0
						? `delete confirm: ${state.killFallbackCurrentIndex + 1}/${state.killFallbackRemaining.length}`
						: `abort armed: ${state.pendingKillChildrenCount} children`
				: deletePromptActive
					? state.isDeletingSession
						? "delete in progress"
						: `delete armed: ${sanitizeText(state.pendingDeleteSessionTitle, "selected session")}`
					: `${focusSummary}${hiddenCompletedSummary}`);
		const rightFooterWidth = rightFooterText.length;
		const leftFooterWidth = Math.max(
			footerAvailableWidth - rightFooterWidth - FOOTER_INLINE_GAP,
			1,
		);

		statusText.width = footerWraps ? footerAvailableWidth : rightFooterWidth;
		statusText.content = state.dbError
			? t`${fg(APP_PALETTE.warning)(state.dbError)}`
			: state.pendingKillSessionId
				? state.isKillingChildren
					? t`${fg(APP_PALETTE.warning)("deleting sessions...")}`
					: state.killFallbackRemaining.length > 0
						? t`${fg(APP_PALETTE.danger)("delete confirm")}${dim(": ")}${footerState(`${state.killFallbackCurrentIndex + 1}/${state.killFallbackRemaining.length}`)}`
						: t`${fg(APP_PALETTE.warning)("abort armed")}${dim(": ")}${footerState(`${state.pendingKillChildrenCount} children`)}`
				: deletePromptActive
					? state.isDeletingSession
						? t`${fg(APP_PALETTE.warning)("delete in progress")}`
						: t`${fg(APP_PALETTE.danger)("delete armed")}${dim(": ")}${footerState(sanitizeText(state.pendingDeleteSessionTitle, "selected session"))}`
					: t`${dim(headerText)}${canSwitchFocus ? dim(" | sort: ") : ""}${canSwitchFocus ? footerState(state.sessionSortMode) : ""}${canSwitchFocus ? dim(" | focus: ") : ""}${canSwitchFocus ? footerState(focusLabel) : ""}${shouldShowHiddenCompleted && state.hiddenCompletedCount > 0 ? dim(" | hidden completed: ") : ""}${shouldShowHiddenCompleted && state.hiddenCompletedCount > 0 ? footerState(state.hiddenCompletedCount.toLocaleString("en-US")) : ""}`;
		statusText.truncate = true;

		controlText.width = footerWraps ? footerAvailableWidth : leftFooterWidth;
		controlText.content = styledShortcutGuide;
		controlText.truncate = !footerWraps;

		footerContainer.width = footerAvailableWidth;
		footerContainer.height = footerHeight;
		footerContainer.flexDirection = footerWraps ? "column" : "row";
		footerContainer.justifyContent = footerWraps ? "flex-start" : "flex-start";
		footerContainer.alignItems = footerWraps ? "stretch" : "center";
		footerContainer.gap = footerWraps ? 0 : FOOTER_INLINE_GAP;
		replaceChildren(
			footerContainer,
			footerWraps ? [statusText, controlText] : [controlText, statusText],
		);

		contentContainer.width = innerWidth;
		contentContainer.height = contentHeight;
		contentContainer.flexDirection = "row";
		contentContainer.gap = 1;

		existingGridScrollBox.visible = showGrid;
		existingGridScrollBox.width = showGrid ? gridWidth : 0;
		existingGridScrollBox.height = contentHeight;
		existingGridScrollBox.borderColor =
			showGrid && state.focusedPane === "grid" ? APP_PALETTE.accent : "#334155";

		existingDetailScrollBox.visible = showDetail;
		existingDetailScrollBox.width = showDetail
			? detailOnlyMode
				? innerWidth
				: detailWidth
			: 0;
		existingDetailScrollBox.height = contentHeight;
		existingDetailScrollBox.borderColor =
			showDetail && state.focusedPane === "detail"
				? APP_PALETTE.accent
				: "#334155";

		existingHierarchyContainer.visible = showHierarchy;
		existingHierarchyContainer.width = showHierarchy ? innerWidth : 0;
		existingHierarchyContainer.height = contentHeight;
		existingHierarchyContainer.borderColor = showHierarchy
			? APP_PALETTE.accent
			: "#334155";

		existingHierarchyHeader.visible = false;
		existingHierarchyHeader.height = 0;
		replaceChildren(existingHierarchyHeader, []);

		existingHierarchyTimelineAnchor.visible = false;
		existingHierarchyTimelineAnchor.height = 0;
		replaceChildren(existingHierarchyTimelineAnchor, []);

		const hierarchyHeaderHeight = 0;
		const timelineAnchorHeight = 0;

		existingHierarchyScrollBox.visible = showHierarchy;
		existingHierarchyScrollBox.width = "100%";
		existingHierarchyScrollBox.height = showHierarchy
			? Math.max(
					contentHeight -
						hierarchyHeaderHeight -
						timelineAnchorHeight -
						HIERARCHY_FRAME_VERTICAL_INSET,
					1,
				)
			: 0;

		if (showGrid) {
			replaceChildren(gridContent, [
				createSessionGridContent({
					sessions: state.sessions,
					selectedIndex: state.selectedIndex,
					isFocusedPane: state.focusedPane === "grid",
					statusBySessionId: state.statusBySessionId,
					onSelectSession: selectSessionById,
					width: gridLayoutWidth,
				}),
			]);
		} else if (gridContent.getChildren().length > 0) {
			replaceChildren(gridContent, []);
		}

		if (showDetail) {
			replaceChildren(detailContent, [
				createDetailPanelContent({
					session: selectedSession,
					messageCount: selectedSession?.id
						? state.messageCountBySessionId[selectedSession.id]
						: undefined,
					sessions: state.allSessions,
					messageCountBySessionId: state.messageCountBySessionId,
					status: selectedState.status,
					summary: selectedState.summary,
					width: detailOnlyMode ? innerWidth : detailWidth,
				}),
			]);
		} else if (detailContent.getChildren().length > 0) {
			replaceChildren(detailContent, []);
		}

		if (showHierarchy) {
			replaceChildren(hierarchyContent, [
				createHierarchyViewContent({
					session: selectedSession,
					messageCountBySessionId: state.messageCountBySessionId,
					viewMode: effectiveHierarchyViewMode,
					infoMode: state.hierarchyInfoMode,
					filterMode: state.hierarchyFilterMode,
					timelineScrollLeft: state.timelineScrollLeft,
					timelineViewportWidth: timelineViewportWidth,
					width: "100%",
					narrowMode: hierarchyNarrowMode,
					timelineAxisAnchored: false,
					sectionMode: "all",
					onCopyId: (id) => {
						renderer.copyToClipboardOSC52(id);
						showToast(`Copied: ${id}`);
					},
				}),
			]);
		} else if (hierarchyContent.getChildren().length > 0) {
			replaceChildren(hierarchyContent, []);
		}

		deleteConfirmationOverlay.visible = deletePromptActive;
		deleteConfirmationOverlay.width = width;
		deleteConfirmationOverlay.height = height;
		replaceChildren(
			deleteConfirmationOverlay,
			deletePromptActive && state.pendingDeleteSessionId
				? [
						createDeleteConfirmationDialog({
							title: sanitizeText(
								state.pendingDeleteSessionTitle,
								"Untitled session",
							),
							sessionId: state.pendingDeleteSessionId,
							width: Math.min(Math.max(width - 8, 36), 72),
							isDeleting: state.isDeletingSession,
							errorMessage: state.deleteConfirmationError,
							sourceLabel: getSessionSourceLabel(
								state.sessions.find(
									(session) => session.id === state.pendingDeleteSessionId,
								)?.sessionSource ?? "opencode",
							),
						}),
					]
				: deletePromptActive &&
						state.pendingKillSessionId &&
						state.killFallbackRemaining.length > 0
					? [
							createKillFallbackDialog({
								childId:
									state.killFallbackRemaining[state.killFallbackCurrentIndex],
								childTitle: sanitizeText(
									state.allSessions
										.flatMap((s) => s.subagentSessions ?? [])
										.find(
											(sub) =>
												sub.id ===
												state.killFallbackRemaining[
													state.killFallbackCurrentIndex
												],
										)?.title ??
										state.sessions.find(
											(s) =>
												s.id ===
												state.killFallbackRemaining[
													state.killFallbackCurrentIndex
												],
										)?.title,
									"Child session",
								),
								currentIndex: state.killFallbackCurrentIndex + 1,
								totalCount: state.killFallbackRemaining.length,
								confirmedCount: state.killFallbackConfirmed.length,
								width: Math.min(Math.max(width - 8, 36), 72),
							}),
						]
					: deletePromptActive && state.pendingKillSessionId
						? [
								createKillChildrenConfirmationDialog({
									sessionTitle: sanitizeText(
										state.sessions.find(
											(s) => s.id === state.pendingKillSessionId,
										)?.title,
										"Selected session",
									),
									sessionId: state.pendingKillSessionId,
									childCount: state.pendingKillChildrenCount,
									width: Math.min(Math.max(width - 8, 36), 72),
									isKilling: state.isKillingChildren,
									errorMessage: state.killChildrenError,
								}),
							]
						: [],
		);

		const toastOverlay = renderer.root.findDescendantById(TOAST_OVERLAY_ID);
		if (isBoxRenderable(toastOverlay)) {
			toastOverlay.visible = state.toastMessage !== null;
			replaceChildren(
				toastOverlay,
				state.toastMessage
					? [
							Text({
								content: state.toastMessage,
								fg: "#94a3b8",
							}),
						]
					: [],
			);
		}

		if (showGrid) {
			existingGridScrollBox.scrollTo({ x: 0, y: state.gridScrollTop });
		}

		if (showDetail && shouldRestoreDetailScroll) {
			existingDetailScrollBox.scrollTo({ x: 0, y: nextDetailScrollTop });
		}

		if (showHierarchy && selectedSession?.id) {
			const savedHierarchyScroll =
				state.hierarchyScrollTopBySessionId[selectedSession.id] ?? 0;
			existingHierarchyScrollBox.scrollTo({
				x: 0,
				y: savedHierarchyScroll,
			});
			state.hierarchyScrollTop = savedHierarchyScroll;
		}

		state.detailScrollTop = showDetail
			? shouldRestoreDetailScroll
				? nextDetailScrollTop
				: existingDetailScrollBox.scrollTop
			: 0;
		state.renderedDetailSessionId = showDetail
			? (selectedSession?.id ?? null)
			: null;
		syncWaitingPulseRendering(showGrid);
		state.gridFollowSelectionOnRender = false;
	};

	const applyRefreshErrorState = (errorMessage: string) => {
		state.allSessions = [];
		state.sessions = [];
		state.statusBySessionId = {};
		state.gridScrollTop = 0;
		state.gridFollowSelectionOnRender = false;
		state.detailScrollTop = 0;
		state.detailScrollTopBySessionId = {};
		state.hierarchyScrollTop = 0;
		state.hierarchyScrollTopBySessionId = {};
		state.timelineScrollLeft = 0;
		state.timelineScrollLeftBySessionId = {};
		state.messageCountBySessionId = {};
		state.sessionIssues = {};
		state.sourceIssues = [];
		state.hiddenCompletedCount = 0;
		state.selectedIndex = -1;
		state.selectedSessionId = null;
		state.externalAttachedSessionIds = new Set();
		state.externalAttachedSessionDirectoryCounts = new Map();
		state.renderedDetailSessionId = null;
		state.detailReturnToSideview = false;
		state.dbError = errorMessage;

		if (state.isDetailMode && state.sessions.length === 0) {
			state.isDetailMode = false;
		}

		render();
	};

	const applyRefreshSnapshotState = (snapshot: RefreshSnapshotPayload) => {
		state.dbError = null;
		state.allSessions = snapshot.sessions;
		state.detailScrollTopBySessionId = pruneSessionScopedNumberState(
			state.detailScrollTopBySessionId,
			snapshot.sessions,
		);
		state.hierarchyScrollTopBySessionId = pruneSessionScopedNumberState(
			state.hierarchyScrollTopBySessionId,
			snapshot.sessions,
		);
		state.timelineScrollLeftBySessionId = pruneSessionScopedNumberState(
			state.timelineScrollLeftBySessionId,
			snapshot.sessions,
		);
		const snapshotSessionIds = new Set(
			snapshot.sessions.map((session) => session.id),
		);

		if (
			state.selectedSessionId &&
			!snapshotSessionIds.has(state.selectedSessionId)
		) {
			state.hierarchyScrollTop = 0;
			state.timelineScrollLeft = 0;
		}

		state.externalAttachedSessionIds = new Set(
			[...state.externalAttachedSessionIds].filter((sessionId) =>
				snapshotSessionIds.has(sessionId),
			),
		);

		const orderedCompletedSessions = snapshot.sessions
			.filter((session) => session.status === SessionStatus.completed)
			.sort((left, right) => right.time_updated - left.time_updated);
		const latestCompletedSessionId = orderedCompletedSessions[0]?.id ?? null;

		const externalDirectoryPinnedSessionIds = new Set<string>();
		if (state.externalAttachedSessionDirectoryCounts.size > 0) {
			const nonCompletedCountByDirectory = new Map<string, number>();
			for (const session of snapshot.sessions) {
				if (session.status === SessionStatus.completed) {
					continue;
				}

				const directoryKey = getExternalAttachedDirectoryKey(
					session.sessionSource,
					normalizeDirectoryPath(session.directory),
				);
				const existingCount =
					nonCompletedCountByDirectory.get(directoryKey) ?? 0;
				nonCompletedCountByDirectory.set(directoryKey, existingCount + 1);
			}

			const remainingDirectorySlots = new Map<string, number>();
			for (const [
				directoryKey,
				totalSlots,
			] of state.externalAttachedSessionDirectoryCounts) {
				const consumedByNonCompleted =
					nonCompletedCountByDirectory.get(directoryKey) ?? 0;
				const remainingSlots = totalSlots - consumedByNonCompleted;
				if (remainingSlots > 0) {
					remainingDirectorySlots.set(directoryKey, remainingSlots);
				}
			}

			for (const session of orderedCompletedSessions) {
				const directoryKey = getExternalAttachedDirectoryKey(
					session.sessionSource,
					normalizeDirectoryPath(session.directory),
				);
				const remainingSlots = remainingDirectorySlots.get(directoryKey) ?? 0;
				if (remainingSlots <= 0) {
					continue;
				}

				externalDirectoryPinnedSessionIds.add(session.id);
				if (remainingSlots === 1) {
					remainingDirectorySlots.delete(directoryKey);
				} else {
					remainingDirectorySlots.set(directoryKey, remainingSlots - 1);
				}
			}
		}

		const pinnedSessionIds = new Set([
			...state.externalAttachedSessionIds,
			...externalDirectoryPinnedSessionIds,
		]);

		const filterResult = applySessionFilter(
			snapshot.sessions,
			state.sessionFilterMode,
			pinnedSessionIds,
			latestCompletedSessionId,
		);
		state.sessions = applySessionSort(
			filterResult.sessions,
			state.sessionSortMode,
		);
		state.hiddenCompletedCount = filterResult.hiddenCompletedCount;
		state.statusBySessionId = snapshot.statusBySessionId;
		state.messageCountBySessionId = snapshot.messageCountBySessionId;
		state.sessionIssues = snapshot.sessionIssues;
		state.sourceIssues = snapshot.sourceIssues;
		state.selectedIndex = getSelectedIndexById(
			state.sessions,
			state.selectedSessionId,
			state.selectedIndex,
		);
		state.selectedSessionId =
			state.selectedIndex >= 0
				? (state.sessions[state.selectedIndex]?.id ?? null)
				: null;

		if (state.sessions.length === 0 && state.isDetailMode) {
			state.isDetailMode = false;
		}

		render();
	};

	const dispatchRefreshRequest = (requestId: RefreshRequestId) => {
		refreshWorker.postMessage(createRequest(requestId));
	};

	const completeRefreshRequest = (requestId: RefreshRequestId) => {
		const nextRequestId = refreshCoordinator.completeRefresh(requestId);

		if (nextRequestId !== null) {
			dispatchRefreshRequest(nextRequestId);
		}
	};

	const hasActiveTextSelection = (): boolean => {
		const selection = renderer.getSelection() as SelectionSnapshot | null;
		return Boolean(selection?.isDragging && !selection.isStart);
	};

	const applyRefreshResponseState = (response: RefreshResponse) => {
		isRefreshApplying = true;
		if (renderStats) renderStats.applyTriggeredRenders++;
		try {
			if (!response.ok) {
				applyRefreshErrorState(response.error.message);
				return;
			}

			applyRefreshSnapshotState(response.snapshot);
		} finally {
			isRefreshApplying = false;
		}
	};

	const applyPendingSelectionRefresh = (): boolean => {
		if (!pendingSelectionRefreshResponse || hasActiveTextSelection()) {
			return false;
		}

		const response = pendingSelectionRefreshResponse;
		pendingSelectionRefreshResponse = null;
		applyRefreshResponseState(response);
		return true;
	};

	const applyPendingSelectionWork = (): boolean => {
		if (applyPendingSelectionRefresh()) {
			return true;
		}

		if (pendingSelectionRender && !hasActiveTextSelection()) {
			render();
			return true;
		}

		return false;
	};

	const clearCompletedTextSelection = (): boolean => {
		const selection = renderer.getSelection() as SelectionSnapshot | null;
		if (!selection || hasActiveTextSelection()) {
			return false;
		}

		renderer.clearSelection();
		applyPendingSelectionWork();
		return true;
	};

	const copyCompletedTextSelection = (): boolean => {
		const selection = renderer.getSelection() as SelectionSnapshot | null;
		if (!selection || hasActiveTextSelection()) {
			return false;
		}

		const selectedText = getSelectionText(selection);
		if (!selectedText) {
			return clearCompletedTextSelection();
		}

		if (selectionCopyTimer) {
			clearTimeout(selectionCopyTimer);
			selectionCopyTimer = null;
		}

		renderer.copyToClipboardOSC52(selectedText);
		renderer.clearSelection();
		applyPendingSelectionWork();
		showToast("Copied selected text to clipboard");
		return true;
	};

	const scheduleCompletedSelectionCopy = () => {
		if (selectionCopyTimer) {
			clearTimeout(selectionCopyTimer);
		}

		selectionCopyTimer = setTimeout(() => {
			selectionCopyTimer = null;
			copyCompletedTextSelection();
		}, 0);
	};

	const handleRefreshResponse = (response: RefreshResponse) => {
		try {
			if (!refreshCoordinator.shouldApplyResponse(response.requestId)) {
				return;
			}

			if (hasActiveTextSelection()) {
				pendingSelectionRefreshResponse = response;
				return;
			}

			applyRefreshResponseState(response);
		} finally {
			completeRefreshRequest(response.requestId);
		}
	};

	const failActiveRefreshRequest = (errorMessage: string) => {
		const activeRequestId = refreshCoordinator.getSnapshot().activeRequestId;
		if (activeRequestId === null) {
			if (hasActiveTextSelection()) {
				return;
			}

			state.dbError = errorMessage;
			render();
			return;
		}

		try {
			if (refreshCoordinator.shouldApplyResponse(activeRequestId)) {
				const response = createErrorResponse(activeRequestId, {
					code: "query_failed",
					message: errorMessage,
				});
				if (hasActiveTextSelection()) {
					pendingSelectionRefreshResponse = response;
					return;
				}

				applyRefreshResponseState(response);
			}
		} finally {
			completeRefreshRequest(activeRequestId);
		}
	};

	refreshWorker.onmessage = (event) => {
		if (!isRefreshResponse(event.data)) {
			return;
		}

		handleRefreshResponse(event.data);
	};

	refreshWorker.onmessageerror = () => {
		failActiveRefreshRequest(
			"Failed to deserialize refresh worker response payload.",
		);
	};

	refreshWorker.onerror = (event) => {
		event.preventDefault();
		const workerErrorMessage = event.error?.message ?? event.message;
		failActiveRefreshRequest(
			workerErrorMessage || "Refresh worker encountered an unexpected error.",
		);
	};

	const refreshSessions = () => {
		if (applyPendingSelectionWork()) {
			return;
		}

		const requestId = refreshCoordinator.requestRefresh();
		if (requestId === null) {
			return;
		}

		try {
			dispatchRefreshRequest(requestId);
		} catch (error) {
			failActiveRefreshRequest(
				error instanceof Error
					? error.message
					: "Failed to dispatch refresh request to worker.",
			);
		}
	};

	const scheduleRender = () => {
		if (isResizeDebouncing.value) {
			clearTimeout(isResizeDebouncing.value);
		}

		isResizeDebouncing.value = setTimeout(() => {
			render();
			isResizeDebouncing.value = null;
		}, RESIZE_DEBOUNCE_MS);
	};

	const scrollDetail = (delta: number) => {
		const detailScrollBox =
			renderer.root.findDescendantById(DETAIL_SCROLLBOX_ID);
		if (!isScrollBoxRenderable(detailScrollBox) || !detailScrollBox.visible) {
			return;
		}

		detailScrollBox.scrollBy({ x: 0, y: delta });
		state.detailScrollTop = detailScrollBox.scrollTop;
		const sessionId = state.renderedDetailSessionId ?? state.selectedSessionId;
		if (sessionId) {
			state.detailScrollTopBySessionId[sessionId] = detailScrollBox.scrollTop;
		}
	};

	const scrollHierarchy = (delta: number) => {
		const hierarchyScrollBox = renderer.root.findDescendantById(
			HIERARCHY_SCROLLBOX_ID,
		);
		if (
			!isScrollBoxRenderable(hierarchyScrollBox) ||
			!hierarchyScrollBox.visible
		) {
			return;
		}

		hierarchyScrollBox.scrollBy({ x: 0, y: delta });
		state.hierarchyScrollTop = hierarchyScrollBox.scrollTop;
		if (state.selectedSessionId) {
			state.hierarchyScrollTopBySessionId[state.selectedSessionId] =
				hierarchyScrollBox.scrollTop;
		}
	};

	const TIMELINE_SCROLL_STEP = 8;

	const isHierarchyNarrowMode = (paneWidth?: number): boolean => {
		const width = getSafeNumber(renderer.width, 80);
		const effectivePaneWidth =
			typeof paneWidth === "number" && Number.isFinite(paneWidth)
				? Math.max(Math.floor(paneWidth), 1)
				: Math.max(width - ROOT_PADDING_X, 1);

		return effectivePaneWidth < HIERARCHY_NARROW_THRESHOLD;
	};

	const getEffectiveHierarchyViewMode = (
		paneWidth?: number,
	): HierarchyViewMode => {
		return isHierarchyNarrowMode(paneWidth) ? "tree" : state.hierarchyViewMode;
	};

	const getCurrentHierarchyTimelineContextWidth = (
		paneWidth?: number,
	): number => {
		return getHierarchyTimelineContextWidth({
			session: state.sessions[state.selectedIndex] ?? null,
			messageCountBySessionId: state.messageCountBySessionId,
			viewMode: state.hierarchyViewMode,
			infoMode: state.hierarchyInfoMode,
			filterMode: state.hierarchyFilterMode,
			narrowMode: isHierarchyNarrowMode(paneWidth),
		});
	};

	const scrollTimeline = (delta: number) => {
		if (getEffectiveHierarchyViewMode() !== "flow") {
			return;
		}

		const viewportWidth = getTimelineViewportWidth();
		const maxScrollLeft = getTimelineTrackWidth(viewportWidth) - viewportWidth;
		const nextScrollLeft = clampNumber(
			state.timelineScrollLeft + delta,
			0,
			Math.max(maxScrollLeft, 0),
		);

		if (nextScrollLeft !== state.timelineScrollLeft) {
			state.timelineScrollLeft = nextScrollLeft;
			if (state.selectedSessionId) {
				state.timelineScrollLeftBySessionId[state.selectedSessionId] =
					nextScrollLeft;
			}
			render();
		}
	};

	const getTimelineViewportWidth = (paneWidth?: number): number => {
		const width = getSafeNumber(renderer.width, 80);
		const fallbackInnerWidth =
			typeof paneWidth === "number" && Number.isFinite(paneWidth)
				? Math.max(Math.floor(paneWidth), 1)
				: Math.max(width - ROOT_PADDING_X, 1);
		const contextWidth = getCurrentHierarchyTimelineContextWidth(paneWidth);
		const hierarchyScrollBox = renderer.root.findDescendantById(
			HIERARCHY_SCROLLBOX_ID,
		);
		const hierarchyScrollbarInset =
			isScrollBoxRenderable(hierarchyScrollBox) &&
			hierarchyScrollBox.visible &&
			hierarchyScrollBox.verticalScrollBar.visible
				? Math.max(
						getSafeNumber(hierarchyScrollBox.verticalScrollBar.width, 1),
						1,
					)
				: 0;
		const fallbackViewportWidth = Math.max(
			fallbackInnerWidth -
				HIERARCHY_CONTAINER_HORIZONTAL_INSET -
				hierarchyScrollbarInset,
			1,
		);
		const measuredViewportWidth =
			isScrollBoxRenderable(hierarchyScrollBox) && hierarchyScrollBox.visible
				? Math.max(
						getSafeNumber(
							hierarchyScrollBox.viewport.width,
							fallbackViewportWidth,
						),
						1,
					)
				: fallbackViewportWidth;

		return Math.max(
			measuredViewportWidth -
				contextWidth -
				HIERARCHY_SCROLLBOX_CONTENT_HORIZONTAL_INSET -
				HIERARCHY_TIMELINE_SECTION_HORIZONTAL_INSET,
			12,
		);
	};

	const clampNumber = (value: number, min: number, max: number): number => {
		return Math.max(min, Math.min(max, value));
	};

	const toggleFocusedPane = () => {
		const detailOnlyMode = state.isDetailMode && !state.isSideviewMode;
		const showGrid = !detailOnlyMode;
		const showDetail = state.isSideviewMode || detailOnlyMode;

		if (!(showGrid && showDetail)) {
			return;
		}

		state.focusedPane = state.focusedPane === "grid" ? "detail" : "grid";
		render();
	};

	const moveSelection = (direction: "left" | "right" | "up" | "down") => {
		if (state.sessions.length === 0) {
			return;
		}

		const fallbackInnerWidth = Math.max(
			getSafeNumber(renderer.width, 80) - ROOT_PADDING_X,
			1,
		);
		const fallbackGridWidth = getGridWidth(
			fallbackInnerWidth,
			state.isSideviewMode,
		);
		const gridScrollBox = renderer.root.findDescendantById(GRID_SCROLLBOX_ID);
		const measuredGridWidth =
			isScrollBoxRenderable(gridScrollBox) && gridScrollBox.visible
				? Math.max(getSafeNumber(gridScrollBox.width, fallbackGridWidth), 1)
				: fallbackGridWidth;
		const measuredGridVerticalScrollbarInset =
			isScrollBoxRenderable(gridScrollBox) &&
			gridScrollBox.visible &&
			gridScrollBox.verticalScrollBar.visible
				? Math.max(getSafeNumber(gridScrollBox.verticalScrollBar.width, 1), 1)
				: 0;
		const measuredGridLayoutWidth = Math.max(
			measuredGridWidth - measuredGridVerticalScrollbarInset,
			1,
		);
		const fallbackColumnCount = Math.max(
			1,
			getGridColumnCount(measuredGridLayoutWidth),
		);
		const renderedColumnCount = getRenderedGridColumnCount(
			renderer.root.findDescendantById(GRID_CONTENT_ID),
			fallbackColumnCount,
		);
		state.renderedGridColumnCount = renderedColumnCount;

		const nextIndex = moveSelectionInGrid({
			sessions: state.sessions,
			selectedIndex: state.selectedIndex < 0 ? 0 : state.selectedIndex,
			columnCount: renderedColumnCount,
			direction,
		});

		if (nextIndex !== state.selectedIndex) {
			state.selectedIndex = nextIndex;
			state.selectedSessionId = state.sessions[nextIndex]?.id ?? null;
			state.gridFollowSelectionOnRender = true;
			render();
		}
	};

	const openSelectedSessionDetail = () => {
		if (state.focusedPane !== "grid" || state.sessions.length === 0) {
			return;
		}

		state.detailReturnToSideview = state.isSideviewMode;
		state.isSideviewMode = false;
		state.isDetailMode = true;
		state.focusedPane = "detail";
		render();
	};

	const closeDetailView = () => {
		if (!state.isDetailMode) {
			return;
		}

		state.isDetailMode = false;
		state.isSideviewMode = state.detailReturnToSideview;
		state.focusedPane = "grid";
		state.detailReturnToSideview = false;
		render();
	};

	const openHierarchyView = (preferredViewMode?: HierarchyViewMode) => {
		if (state.sessions.length === 0 || !state.selectedSessionId) {
			return;
		}

		if (preferredViewMode) {
			state.hierarchyViewMode = preferredViewMode;
		}

		state.hierarchyOrigin =
			state.isDetailMode || state.focusedPane === "detail" ? "detail" : "grid";
		state.isHierarchyMode = true;
		render();
	};

	const closeHierarchyView = () => {
		if (!state.isHierarchyMode) {
			return;
		}

		state.isHierarchyMode = false;
		state.focusedPane = state.hierarchyOrigin;
		state.hierarchyOrigin = "grid";
		render();
	};

	const cycleSessionFilterMode = () => {
		state.sessionFilterMode = getNextSessionFilterMode(state.sessionFilterMode);
		state.gridFollowSelectionOnRender = true;
		refreshSessions();
	};

	const cycleSessionSortMode = () => {
		state.sessionSortMode = getNextSessionSortMode(state.sessionSortMode);
		state.gridFollowSelectionOnRender = true;
		refreshSessions();
	};

	const cycleHierarchyFilterMode = () => {
		state.hierarchyFilterMode = getNextHierarchyFilterMode(
			state.hierarchyFilterMode,
		);
		render();
	};

	const cycleHierarchyViewMode = () => {
		if (state.hierarchyViewMode === "flow" && state.selectedSessionId) {
			state.timelineScrollLeftBySessionId[state.selectedSessionId] =
				state.timelineScrollLeft;
		}

		state.hierarchyViewMode = getNextHierarchyViewMode(state.hierarchyViewMode);

		if (state.hierarchyViewMode === "flow" && state.selectedSessionId) {
			state.timelineScrollLeft =
				state.timelineScrollLeftBySessionId[state.selectedSessionId] ?? 0;
		}

		render();
	};

	const cycleHierarchyInfoMode = () => {
		state.hierarchyInfoMode = getNextHierarchyInfoMode(state.hierarchyInfoMode);
		render();
	};

	const showToast = (message: string) => {
		if (state.toastTimer) {
			clearTimeout(state.toastTimer);
		}

		state.toastMessage = message;
		state.toastTimer = setTimeout(() => {
			state.toastMessage = null;
			state.toastTimer = null;
			render();
		}, 2000);
		render();
	};

	const copySelectedSessionId = () => {
		if (!state.selectedSessionId) {
			return;
		}

		renderer.copyToClipboardOSC52(state.selectedSessionId);
		showToast(`Copied: ${state.selectedSessionId}`);
	};

	const openDeleteConfirmation = () => {
		if (
			state.isAttachingSession ||
			state.isDeletingSession ||
			!state.selectedSessionId
		) {
			return;
		}

		const selectedSession = state.sessions.find(
			(session) => session.id === state.selectedSessionId,
		);
		if (!selectedSession) {
			return;
		}

		if (!canDeleteSession(selectedSession)) {
			showToast(
				`${getSessionSourceLabel(selectedSession.sessionSource)} delete is not available yet`,
			);
			return;
		}

		state.pendingDeleteSessionId = selectedSession.id;
		state.pendingDeleteSessionTitle = sanitizeText(
			selectedSession.title,
			"Untitled session",
		);
		state.deleteConfirmationError = null;
		render();
	};

	const cancelDeleteConfirmation = () => {
		if (!state.pendingDeleteSessionId && !state.deleteConfirmationError) {
			return;
		}

		state.pendingDeleteSessionId = null;
		state.pendingDeleteSessionTitle = null;
		state.deleteConfirmationError = null;
		state.isDeletingSession = false;
		render();
	};

	const confirmDeleteSession = async () => {
		if (!state.pendingDeleteSessionId || state.isDeletingSession) {
			return;
		}

		const sessionId = state.pendingDeleteSessionId;
		const selectedSession = state.sessions.find(
			(session) => session.id === sessionId,
		);
		state.isDeletingSession = true;
		state.deleteConfirmationError = null;
		stopPolling();
		render();
		renderer.intermediateRender();

		try {
			if (selectedSession?.sessionSource === "codex") {
				const deleteResult = await deleteCodexSession(sessionId);
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.message,
						"Codex session delete failed.",
					);
					render();
					return;
				}
			} else if (selectedSession?.sessionSource === "claude") {
				const deleteResult = await deleteClaudeSession(sessionId);
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.message,
						"Claude Code session delete failed.",
					);
					render();
					return;
				}
			} else if (selectedSession?.sessionSource === "pi") {
				const deleteResult = await deletePiSession(sessionId, {
					sessionPath: selectedSession.sourceMetadata?.sessionPath,
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.message,
						"Pi session delete failed.",
					);
					render();
					return;
				}
			} else if (selectedSession?.sessionSource === "omp") {
				const deleteResult = await deleteOmpSession(sessionId, {
					sessionPath: selectedSession.sourceMetadata?.sessionPath,
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.message,
						"omp session delete failed.",
					);
					render();
					return;
				}
			} else {
				const opencodeExecutable = Bun.which("opencode") ?? "opencode";
				const child = Bun.spawn({
					cmd: [opencodeExecutable, "session", "delete", sessionId],
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdoutPromise = child.stdout
					? new Response(child.stdout).text()
					: Promise.resolve("");
				const stderrPromise = child.stderr
					? new Response(child.stderr).text()
					: Promise.resolve("");
				const [stdoutText, stderrText, exitCode] = await Promise.all([
					stdoutPromise,
					stderrPromise,
					child.exited,
				]);

				if (exitCode !== 0) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						stderrText || stdoutText,
						`opencode session delete exited with code ${exitCode}.`,
					);
					render();
					return;
				}
			}

			state.isDeletingSession = false;
			state.pendingDeleteSessionId = null;
			state.pendingDeleteSessionTitle = null;
			state.deleteConfirmationError = null;
			state.gridFollowSelectionOnRender = true;
			refreshSessions();
		} catch (error) {
			state.isDeletingSession = false;
			state.deleteConfirmationError =
				error instanceof Error
					? error.message
					: `Failed to start ${getSessionSourceLabel(selectedSession?.sessionSource ?? "opencode")} session delete.`;
			render();
		} finally {
			startPolling();
		}
	};

	const openKillChildrenConfirmation = () => {
		if (
			state.isAttachingSession ||
			state.isDeletingSession ||
			state.isKillingChildren
		)
			return;
		if (!state.selectedSessionId) return;

		const selectedSession = state.sessions.find(
			(s) => s.id === state.selectedSessionId,
		);
		if (!selectedSession) return;
		if (!canAbortSessionChildren(selectedSession)) {
			showToast(
				`${getSessionSourceLabel(selectedSession.sessionSource)} child abort is not available yet`,
			);
			return;
		}

		const allChildren = selectedSession.subagentSessions ?? [];
		const activeChildren = allChildren.filter(
			(s) =>
				s.status !== SessionStatus.completed &&
				s.status !== SessionStatus.failed,
		);

		if (activeChildren.length === 0) {
			showToast("No active child sessions to abort");
			return;
		}

		state.pendingKillSessionId = selectedSession.id;
		state.pendingKillChildrenCount = activeChildren.length;
		state.killChildrenError = null;
		state.isKillingChildren = false;
		render();
	};

	const cancelKillChildrenConfirmation = () => {
		if (
			!state.pendingKillSessionId &&
			!state.killChildrenError &&
			state.killFallbackRemaining.length === 0
		)
			return;
		state.pendingKillSessionId = null;
		state.pendingKillChildrenCount = 0;
		state.isKillingChildren = false;
		state.killChildrenError = null;
		state.killFallbackRemaining = [];
		state.killFallbackConfirmed = [];
		state.killFallbackCurrentIndex = 0;
		render();
	};

	const gracefulAbortSession = async (
		session: SubagentSession,
		projectDir: string,
	): Promise<{ ok: boolean; error?: string }> => {
		if (session.sessionSource === "codex") {
			return abortCodexChildSession(session);
		}

		try {
			const opencodeExecutable = Bun.which("opencode") ?? "opencode";
			const proc = Bun.spawn({
				cmd: [opencodeExecutable, "run", "--session", session.id, "stop"],
				cwd: projectDir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await Promise.race([
				proc.exited,
				new Promise<number>((_, reject) =>
					setTimeout(() => {
						proc.kill();
						reject(new Error("timed out"));
					}, 15000),
				),
			]);
			if (exitCode === 0) return { ok: true };
			return { ok: false, error: `exit code ${exitCode}` };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : "Failed to run abort",
			};
		}
	};

	const confirmKillChildren = async () => {
		if (!state.pendingKillSessionId || state.isKillingChildren) return;

		const rootSessionId = state.pendingKillSessionId;
		const selectedSession = state.allSessions.find(
			(s) => s.id === rootSessionId,
		);
		if (!selectedSession?.subagentSessions?.length) {
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.isKillingChildren = false;
			state.killChildrenError = null;
			render();
			return;
		}

		const activeChildren = selectedSession.subagentSessions.filter(
			(s) =>
				s.status !== SessionStatus.completed &&
				s.status !== SessionStatus.failed,
		);

		if (activeChildren.length === 0) {
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.isKillingChildren = false;
			state.killChildrenError = null;
			render();
			return;
		}
		state.isKillingChildren = true;
		state.killChildrenError = null;
		stopPolling();
		render();
		renderer.intermediateRender();

		try {
			const projectDir = selectedSession.directory || process.cwd();

			const results = await Promise.allSettled(
				activeChildren.map((child) => gracefulAbortSession(child, projectDir)),
			);
			const failedIds = activeChildren
				.filter((_, i) => {
					const result = results[i];
					return (
						!result ||
						result.status === "rejected" ||
						(result.status === "fulfilled" && !result.value.ok)
					);
				})
				.map((child) => child.id);
			const successCount = activeChildren.length - failedIds.length;

			if (failedIds.length > 0) {
				state.isKillingChildren = false;
				state.killFallbackRemaining = failedIds;
				state.killFallbackConfirmed = [];
				state.killFallbackCurrentIndex = 0;
				if (successCount > 0) {
					showToast(
						`Stopped ${successCount}/${activeChildren.length} children (${failedIds.length} need delete)`,
					);
				}
				startPolling();
				render();
				return;
			}

			state.isKillingChildren = false;
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.killChildrenError = null;
			state.gridFollowSelectionOnRender = true;

			showToast(`Stopped ${activeChildren.length} child sessions`);
			startPolling();
			refreshSessions();
		} catch (error) {
			state.isKillingChildren = false;
			state.killChildrenError =
				error instanceof Error
					? error.message
					: "Failed to abort child sessions.";
			startPolling();
			render();
		}
	};

	const advanceKillFallbackConfirmation = (confirmCurrent: boolean) => {
		const remaining = state.killFallbackRemaining;
		const index = state.killFallbackCurrentIndex;

		if (index >= remaining.length) return;

		const currentId = remaining[index];
		if (confirmCurrent) {
			state.killFallbackConfirmed = [...state.killFallbackConfirmed, currentId];
		}

		const nextIndex = index + 1;

		if (nextIndex >= remaining.length) {
			executeKillFallbackDelete();
			return;
		}

		state.killFallbackCurrentIndex = nextIndex;
		render();
	};

	const executeKillFallbackDelete = async () => {
		const confirmedIds = state.killFallbackConfirmed;
		if (confirmedIds.length === 0) {
			state.killFallbackRemaining = [];
			state.killFallbackConfirmed = [];
			state.killFallbackCurrentIndex = 0;
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.killChildrenError = null;
			render();
			return;
		}

		state.isKillingChildren = true;
		state.killChildrenError = null;
		stopPolling();
		render();
		renderer.intermediateRender();

		try {
			const rootSession = state.allSessions.find(
				(session) => session.id === state.pendingKillSessionId,
			);
			const results = await Promise.allSettled(
				confirmedIds.map(async (childId) => {
					if (rootSession?.sessionSource === "codex") {
						const result = await deleteCodexSession(childId);
						if (!result.ok) {
							throw result.error;
						}

						return childId;
					}

					const opencodeExecutable = Bun.which("opencode") ?? "opencode";
					const child = Bun.spawn({
						cmd: [opencodeExecutable, "session", "delete", childId],
						stdout: "pipe",
						stderr: "pipe",
					});
					const exitCode = await child.exited;
					if (exitCode !== 0) {
						throw new Error(`Failed to delete ${childId}`);
					}

					return childId;
				}),
			);
			const failedCount = results.filter((r) => r.status === "rejected").length;
			const successCount = confirmedIds.length - failedCount;

			state.isKillingChildren = false;
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.killChildrenError = null;
			state.killFallbackRemaining = [];
			state.killFallbackConfirmed = [];
			state.killFallbackCurrentIndex = 0;
			state.gridFollowSelectionOnRender = true;

			if (failedCount > 0) {
				showToast(
					`Deleted ${successCount}/${confirmedIds.length} children (${failedCount} failed)`,
				);
			} else {
				showToast(`Deleted ${confirmedIds.length} child sessions`);
			}
			startPolling();
			refreshSessions();
		} catch (error) {
			state.isKillingChildren = false;
			state.killChildrenError =
				error instanceof Error ? error.message : "Failed to delete sessions.";
			startPolling();
			render();
		}
	};

	const cancelKillFallbackConfirmation = () => {
		state.pendingKillSessionId = null;
		state.pendingKillChildrenCount = 0;
		state.killChildrenError = null;
		state.killFallbackRemaining = [];
		state.killFallbackConfirmed = [];
		state.killFallbackCurrentIndex = 0;
		render();
	};

	const attachToSelectedSession = async () => {
		writeAttachDebug("attach:requested", {
			isAttachingSession: state.isAttachingSession,
			selectedSessionId: state.selectedSessionId,
			visibleSessionCount: state.sessions.length,
		});

		if (state.isAttachingSession || !state.selectedSessionId) {
			writeAttachDebug("attach:blocked", {
				reason: state.isAttachingSession ? "already-attaching" : "no-selection",
			});
			return;
		}

		const selectedSession = state.sessions.find(
			(session) => session.id === state.selectedSessionId,
		);
		if (!selectedSession) {
			writeAttachDebug("attach:blocked", { reason: "selection-not-found" });
			return;
		}
		writeAttachDebug("attach:selected", {
			id: selectedSession.id,
			title: selectedSession.title,
			source: selectedSession.sessionSource,
			status: selectedSession.status,
			directory: selectedSession.directory,
			parentId: selectedSession.parent_id,
			sessionPath: selectedSession.sourceMetadata?.sessionPath,
		});

		if (!canAttachToSession(selectedSession)) {
			writeAttachDebug("attach:blocked", { reason: "capability-disabled" });
			showToast(
				`${getSessionSourceLabel(selectedSession.sessionSource)} attach is not available yet`,
			);
			return;
		}

		const attachLaunchSpec = getAttachLaunchSpec(selectedSession, {
			fallbackDirectory: process.cwd(),
		});
		if (!attachLaunchSpec) {
			writeAttachDebug("attach:blocked", { reason: "no-launch-spec" });
			showToast(
				`${getSessionSourceLabel(selectedSession.sessionSource)} attach is not available yet`,
			);
			return;
		}
		writeAttachDebug("attach:launch-spec", {
			cmd: attachLaunchSpec.cmd,
			cwd: attachLaunchSpec.cwd,
		});

		state.isAttachingSession = true;
		render();
		renderer.intermediateRender();

		if (interval) {
			clearInterval(interval);
			interval = null;
		}

		let attachExitCode: number | null = null;
		let attachErrorMessage: string | null = null;

		try {
			renderer.suspend();
			clearTerminalScreen();
			attachExitCode = await runAttachedSession(attachLaunchSpec);
		} catch (error) {
			attachErrorMessage =
				error instanceof Error
					? error.message
					: "Failed to start attach session.";
			writeAttachDebug("attach:error", { message: attachErrorMessage });
		} finally {
			writeAttachDebug("attach:finally", {
				exitCode: attachExitCode,
				errorMessage: attachErrorMessage,
			});
			state.isAttachingSession = false;
			clearTerminalScreen();
			renderer.resume();
			refreshSessions();
			startPolling();
			if (attachErrorMessage) {
				showToast(attachErrorMessage);
			} else if (attachExitCode !== null && attachExitCode !== 0) {
				const message = `${getSessionSourceLabel(selectedSession.sessionSource)} attach exited with code ${attachExitCode}`;
				showToast(
					isAttachDebugEnabled()
						? `${message} (debug: ${getAttachDebugPath()})`
						: message,
				);
			}
			render();
			renderer.intermediateRender();
		}
	};

	const selectSessionById = (sessionId: string) => {
		const nextIndex = state.sessions.findIndex(
			(session) => session.id === sessionId,
		);
		if (nextIndex < 0) {
			return;
		}

		if (
			state.selectedSessionId === sessionId &&
			state.selectedIndex === nextIndex
		) {
			openSelectedSessionDetail();
			return;
		}

		state.selectedIndex = nextIndex;
		state.selectedSessionId = sessionId;
		state.focusedPane = "grid";
		state.gridFollowSelectionOnRender = true;
		render();
	};

	const flushRenderStats = () => {
		if (renderStats && renderStatsPath) {
			try {
				writeFileSync(
					renderStatsPath,
					JSON.stringify(
						{
							source: "actual-worker-app",
							applyTriggeredRenders: renderStats.applyTriggeredRenders,
							liveFrameRenders: renderStats.liveFrameRenders,
							liveFrameSkippedDuringApply:
								renderStats.liveFrameSkippedDuringApply,
							totalLiveCallbacks:
								renderStats.liveFrameRenders +
								renderStats.liveFrameSkippedDuringApply,
							guardActive:
								renderStats.liveFrameSkippedDuringApply > 0 ||
								renderStats.applyTriggeredRenders > 0,
							capturedAt: new Date().toISOString(),
						},
						null,
						2,
					),
				);
			} catch {}
		}
	};

	const shutdown = () => {
		try {
			refreshWorker.terminate();
		} catch {}

		if (isResizeDebouncing.value) {
			clearTimeout(isResizeDebouncing.value);
			isResizeDebouncing.value = null;
		}

		if (selectionCopyTimer) {
			clearTimeout(selectionCopyTimer);
			selectionCopyTimer = null;
		}

		if (isWaitingPulseLive) {
			renderer.dropLive();
			isWaitingPulseLive = false;
			lastWaitingPulseFrameRenderAt = 0;
		}

		stopPolling();

		flushRenderStats();
		renderer.destroy();
		process.exit(0);
	};

	renderer.on("resize", scheduleRender);
	renderer.on("selection", (selection: SelectionSnapshot | null) => {
		if (!selection) {
			clearCompletedTextSelection();
			return;
		}

		scheduleCompletedSelectionCopy();
	});
	createStaticLayout();

	(
		renderer.keyInput as unknown as {
			on(event: "keypress", handler: (key: KeyEvent) => void): void;
		}
	).on("keypress", (key) => {
		if (key.ctrl && key.name === "c") {
			shutdown();
			return;
		}

		copyCompletedTextSelection();

		if (state.pendingDeleteSessionId) {
			if (state.isDeletingSession) {
				return;
			}

			if (
				matchesPhysicalKey(key, {
					names: ["y"],
					codes: ["keyy"],
					sequences: ["y"],
				})
			) {
				void confirmDeleteSession();
				return;
			}

			if (
				key.name === "escape" ||
				key.name === "q" ||
				matchesPhysicalKey(key, {
					names: ["n"],
					codes: ["keyn"],
					sequences: ["n"],
				})
			) {
				cancelDeleteConfirmation();
				return;
			}

			return;
		}

		if (state.pendingKillSessionId) {
			if (state.isKillingChildren) return;

			if (state.killFallbackRemaining.length > 0) {
				if (
					matchesPhysicalKey(key, {
						names: ["y"],
						codes: ["keyy"],
						sequences: ["y"],
					})
				) {
					advanceKillFallbackConfirmation(true);
					return;
				}

				if (
					matchesPhysicalKey(key, {
						names: ["n"],
						codes: ["keyn"],
						sequences: ["n"],
					})
				) {
					advanceKillFallbackConfirmation(false);
					return;
				}

				if (key.name === "escape" || key.name === "q") {
					cancelKillFallbackConfirmation();
					return;
				}

				return;
			}

			if (
				matchesPhysicalKey(key, {
					names: ["y"],
					codes: ["keyy"],
					sequences: ["y"],
				})
			) {
				void confirmKillChildren();
				return;
			}

			if (
				key.name === "escape" ||
				key.name === "q" ||
				matchesPhysicalKey(key, {
					names: ["n"],
					codes: ["keyn"],
					sequences: ["n"],
				})
			) {
				cancelKillChildrenConfirmation();
				return;
			}

			return;
		}

		// Hierarchy mode key handling
		if (state.isHierarchyMode) {
			if (matchesPhysicalKey(key, { names: ["tab"] })) {
				cycleHierarchyViewMode();
				return;
			}

			if (
				matchesPhysicalKey(key, {
					names: ["x"],
					codes: ["keyx"],
					sequences: ["x"],
				})
			) {
				cycleHierarchyInfoMode();
				return;
			}

			if (
				matchesPhysicalKey(key, {
					names: ["f"],
					codes: ["keyf"],
					sequences: ["f"],
				})
			) {
				cycleHierarchyFilterMode();
				return;
			}

			if (key.name === "j" || key.name === "down") {
				scrollHierarchy(DETAIL_SCROLL_STEP);
				return;
			}

			if (key.name === "k" || key.name === "up") {
				scrollHierarchy(-DETAIL_SCROLL_STEP);
				return;
			}

			if (getEffectiveHierarchyViewMode() === "flow") {
				if (key.name === "left" || key.name === "h") {
					scrollTimeline(-TIMELINE_SCROLL_STEP);
					return;
				}

				if (key.name === "right" || key.name === "l") {
					scrollTimeline(TIMELINE_SCROLL_STEP);
					return;
				}
			}

			if (key.name === "escape" || key.name === "q") {
				closeHierarchyView();
				return;
			}

			return;
		}

		if (matchesPhysicalKey(key, { names: ["tab"] })) {
			toggleFocusedPane();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["f"],
				codes: ["keyf"],
				sequences: ["f"],
			})
		) {
			cycleSessionFilterMode();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["s"],
				codes: ["keys"],
				sequences: ["s"],
			})
		) {
			cycleSessionSortMode();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["a"],
				codes: ["keya"],
				sequences: ["a"],
			})
		) {
			void attachToSelectedSession();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["i"],
				codes: ["keyi"],
				sequences: ["i"],
			})
		) {
			copySelectedSessionId();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: [TIMELINE_SHORTCUT_LABEL],
				codes: ["keyt"],
				sequences: [TIMELINE_SHORTCUT_LABEL],
			})
		) {
			openHierarchyView("flow");
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["c"],
				codes: ["keyc"],
				sequences: ["c"],
			})
		) {
			openHierarchyView();
			return;
		}

		if (
			key.name === "k" &&
			key.shift &&
			(state.isDetailMode || state.isSideviewMode)
		) {
			openKillChildrenConfirmation();
			return;
		}

		if (
			matchesPhysicalKey(key, {
				names: ["d"],
				codes: ["keyd"],
				sequences: ["d"],
			})
		) {
			openDeleteConfirmation();
			return;
		}

		if (isSideviewShortcut(key)) {
			state.isSideviewMode = !state.isSideviewMode;
			state.detailReturnToSideview = false;
			if (!state.isSideviewMode) {
				state.isDetailMode = false;
				state.focusedPane = "grid";
			} else if (state.isDetailMode) {
				state.focusedPane = "grid";
			}

			render();
			return;
		}

		switch (key.name) {
			case "h":
			case "left":
				if (state.focusedPane === "grid") {
					moveSelection("left");
				}
				break;

			case "j":
			case "down":
				if (state.focusedPane === "detail") {
					scrollDetail(DETAIL_SCROLL_STEP);
					break;
				}

				moveSelection("down");
				break;

			case "l":
			case "right":
				if (state.focusedPane === "grid") {
					moveSelection("right");
				}
				break;

			case "k":
			case "up":
				if (state.focusedPane === "detail") {
					scrollDetail(-DETAIL_SCROLL_STEP);
					break;
				}

				moveSelection("up");
				break;

			case "return":
			case "enter":
				openSelectedSessionDetail();
				break;

			case "escape":
			case "q":
				if (state.isDetailMode) {
					closeDetailView();
					break;
				}

				shutdown();
				break;

			default:
				break;
		}
	});

	renderer.setFrameCallback(async () => {
		if (!isWaitingPulseLive) {
			return;
		}

		if (isRefreshApplying) {
			if (renderStats) renderStats.liveFrameSkippedDuringApply++;
			return;
		}

		const now = Date.now();
		if (now - lastWaitingPulseFrameRenderAt < WAITING_PULSE_FRAME_INTERVAL_MS) {
			return;
		}
		lastWaitingPulseFrameRenderAt = now;

		if (renderStats) renderStats.liveFrameRenders++;
		render();
	});

	renderer.start();
	void refreshExternalAttachedSessionSignals();
	refreshSessions();
	startPolling();

	render();

	process.on("exit", () => {
		try {
			refreshWorker.terminate();
		} catch {}

		stopPolling();
		flushRenderStats();
	});
};

void main();
