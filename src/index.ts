import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	type BorderSides,
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
	StyledText,
	Text,
	type TextRenderable,
	t,
} from "@opentui/core";
import { deleteClaudeSession } from "./db/claude";
import { deleteCodexSession } from "./db/codex";
import { abortCodexChildSession } from "./db/codex-child-abort";
import { stopJsonlSession } from "./db/jsonl-session-stop";
import { deleteMissionControlSession } from "./db/missionControl";
import { stopOpencodeSession } from "./db/opencode-session-stop";
import { deleteGjcSession, deleteOmpSession, deletePiSession } from "./db/pi";
import {
	createRefreshResetRequest,
	createRefreshWorkerReadyRequest,
	createRequest,
	isRefreshResponse,
	isRefreshWorkerControlAcknowledgement,
	type RefreshRequest,
	type RefreshResetRequest,
	type RefreshResponse,
	type RefreshSnapshotPayload,
	type RefreshWorkerControlAcknowledgement,
	type RefreshWorkerReadyRequest,
	type RefreshWorkerRequest,
} from "./db/refresh-worker-protocol";
import { formatAbortTargetSummary, getAbortTargets } from "./lib/abortTargets";
import {
	getExternalAttachedDirectoryKey,
	isSessionProcessComm,
	parseAttachedSessionIdsFromProcessList,
} from "./lib/attachedSessionSignals";
import { handleDetailMouseDown as handleDetailMouseDownEvent } from "./lib/detailMouse";
import {
	clampGridScrollTop,
	clampSelection,
	getGridVisibleRowCount,
	getRenderedGridColumnCount,
	moveSelectionByPageInGrid,
	moveSelectionInGrid,
} from "./lib/gridScroll";
import { resolveKillFallbackRoute } from "./lib/killFallbackRoute";
import {
	executeMissionControlFallback,
	type MissionControlFallbackPlan,
	prepareMissionControlChildAbort,
} from "./lib/missionControlChildAbort";
import { patchTextBufferViewSelection } from "./lib/opentuiSelectionPatch";
import {
	createRefreshCoordinator,
	RefreshCompletionError,
	type RefreshRequestId,
} from "./lib/refreshCoordinator";
import { createRefreshRenderSignature } from "./lib/refreshRenderSignature";
import {
	applySessionFilter,
	applySessionSort,
	isSettledSession,
	normalizeDirectoryPath,
	type SessionFilterMode,
	type SessionSortMode,
	selectDirectoryPinnedSessionIds,
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
import { isSessionStopShortcut } from "./lib/sessionStopShortcut";
import {
	getTextSelectionText,
	isTextSelectionInProgress,
} from "./lib/textSelection";
import { which } from "./lib/which";
import type {
	HierarchyFilterMode,
	HierarchyInfoMode,
	HierarchyViewMode,
	Session,
	SessionStatus,
	SubagentSession,
} from "./types";
import {
	createDetailPanelContent,
	getDetailPanelContentWidth,
} from "./ui/DetailPanel";
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
const STATS_OVERLAY_ID = "session-monitor-stats-overlay";
const GRID_SCROLLBOX_ID = "session-grid-scrollbox";
const GRID_CONTENT_ID = "session-grid-content";
const DETAIL_CONTAINER_ID = "session-detail-container";
const DETAIL_FRAME_OVERLAY_ID = "session-detail-frame-overlay";
const DETAIL_SCROLLBOX_ID = "session-detail-scrollbox";
const DETAIL_CONTENT_ID = "session-detail-content";
const DETAIL_SCROLLBOX_WRAPPER_PADDING = 1;
const DETAIL_SCROLLBOX_SCROLLBAR_WIDTH = 2;
const DETAIL_SCROLL_SECTION_BORDER_COLOR = "#1E293B";
const DETAIL_SCROLL_SECTION_BORDER: BorderSides[] = ["top", "bottom"];
const HIERARCHY_CONTAINER_ID = "session-hierarchy-container";
const HIERARCHY_FRAME_OVERLAY_ID = "session-hierarchy-frame-overlay";
const HIERARCHY_HEADER_ID = "session-hierarchy-header";
const HIERARCHY_TIMELINE_ANCHOR_ID = "session-hierarchy-timeline-anchor";
const HIERARCHY_SCROLLBOX_ID = "session-hierarchy-scrollbox";
const HIERARCHY_CONTENT_ID = "session-hierarchy-content";
const POLL_INTERVAL_MS = 2000;
const ATTACHED_SIGNAL_INTERVAL_MS = 10_000;
const RESIZE_DEBOUNCE_MS = 150;
const DETAIL_SCROLL_STEP = 3;
const SIDEVIEW_SHORTCUT_LABEL = "e/p";
const FILTER_SHORTCUT_LABEL = "f";
const ATTACH_SHORTCUT_LABEL = "a";
const COPY_ID_SHORTCUT_LABEL = "i";
const DELETE_SHORTCUT_LABEL = "d";
const KILL_CHILDREN_SHORTCUT_LABEL = "Ctrl+K";
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
const FRESHNESS_DISCLOSURE =
	"agent values update independently | known Pi/omp/gjc files: 2s | new/removed-path discovery: 10s";
// Emitted synchronously to fd 1 right before process.exit on shutdown.
// opentui 0.3.x wrapped every render frame in Synchronized Updates
// (?2026h...?2026l) but never emitted a closing ?2026l on teardown, so Kitty
// kept the leave-alt-screen byte (?1049l) buffered inside that open BSU window
// and - with process.exit firing immediately - never applied it, stranding
// Kitty on the alternate screen with no scrollback. opentui 0.4.2 dropped BSU
// entirely (no ?2026h on render, none on teardown), so the original buffering
// hazard is gone. The leading ?2026l is kept as defense-in-depth: it closes any
// BSU window gctrl itself opens via ALT_SCREEN_CLEAR_SEQUENCE during an
// interrupted attach, and is a harmless no-op when none is open. The remaining
// sequence provides a synchronous (writeSync) flush guarantee of the full
// teardown before process.exit - opentui's own destroy() emits the same idempotent
// disable bytes (?1049l + mouse + paste + cursor) but those writes may be cut off
// by an immediate exit; re-stating them here is an intentional belt-and-suspenders
// double-fire (bin/gctrl.js repeats it again on child exit to cover signal-kills).
const RESTORE_PRIMARY_SCREEN_SEQUENCE =
	"\u001B[?2026l" +
	"\u001B[?1049l" +
	"\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l" +
	"\u001B[?2004l" +
	"\u001B[?25h";
const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[H";

// Re-enter the alternate screen and wipe it, wrapped in a Synchronized-Update
// window so Kitty applies the switch + clear atomically (no flash of the stale
// gctrl frame). renderer.suspend() drops us to the primary screen; we then climb
// back onto a clean alternate buffer so the attached CLI (codex/claude/opencode -
// all main-screen BSU renderers that never emit their own ?1049h) paints there
// instead of overwriting the primary screen. That keeps pre-gctrl scrollback
// intact and removes the stale-frame ghost the child would otherwise paint over.
// Blocking writeSync so the buffer switch reaches the kernel PTY before spawn.
const ALT_SCREEN_CLEAR_SEQUENCE =
	"\u001B[?2026h" + "\u001B[?1049h" + "\u001B[2J\u001B[H" + "\u001B[?2026l";
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

const getConservativeTerminalCellWidth = (value: string): number => {
	let width = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		width += codePoint !== undefined && codePoint <= 0x7f ? 1 : 2;
	}
	return width;
};

const getWrappedTerminalLineCount = (
	value: string,
	availableWidth: number,
): number => {
	const width = Math.max(availableWidth, 1);
	return value.split(/\r?\n/).reduce((lineCount, line) => {
		let wrappedLineCount = 1;
		let occupiedWidth = 0;
		for (const character of line) {
			const characterWidth = getConservativeTerminalCellWidth(character);
			if (occupiedWidth > 0 && occupiedWidth + characterWidth > width) {
				wrappedLineCount += 1;
				occupiedWidth = 0;
			}
			occupiedWidth += Math.min(characterWidth, width);
		}
		return lineCount + wrappedLineCount;
	}, 0);
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

	const fragments = [`sessions: ${state.allSessions.length}`];

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
	pendingDeleteTarget: PendingDeleteTarget | null;
	deleteConfirmationError: string | null;
	pendingKillSessionId: string | null;
	pendingKillChildrenCount: number;
	pendingKillIncludesSelected: boolean;
	pendingKillSummary: string | null;
	isKillingChildren: boolean;
	killChildrenError: string | null;
	killFallbackRemaining: string[];
	killFallbackConfirmed: string[];
	killFallbackCurrentIndex: number;
	killFallbackNotice: string | null;
	missionControlFallbackPlan: MissionControlFallbackPlan | null;
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
	isStatsModalVisible: boolean;
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

interface PendingDeleteTarget {
	readonly id: string;
	readonly title: string;
	readonly source: Session["sessionSource"];
	readonly sessionPath: string | undefined;
	readonly missionControlDatabasePath: string | undefined;
}

type RefreshWorkerStatus =
	| "starting"
	| "usable"
	| "resetting"
	| "retiring"
	| "failed";

type RefreshWorkerControlKind = "ready" | "reset";

interface RefreshWorkerControlWaiter {
	kind: RefreshWorkerControlKind;
	generation: number;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface RefreshWorkerLifecycle {
	worker: Worker;
	status: RefreshWorkerStatus;
	resetWaiter: RefreshWorkerControlWaiter | null;
	retirementPromise: Promise<void> | null;
	recoveryPromise: Promise<void> | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const normalizeDetailSectionBorders = (node: unknown): void => {
	if (!isRecord(node)) {
		return;
	}

	const props = isRecord(node.props) ? node.props : null;
	if (
		props?.border === true &&
		props.borderColor === DETAIL_SCROLL_SECTION_BORDER_COLOR
	) {
		props.border = [...DETAIL_SCROLL_SECTION_BORDER];
	}

	if (!Array.isArray(node.children)) {
		return;
	}

	for (const child of node.children) {
		normalizeDetailSectionBorders(child);
	}
};

const clearTerminalScreen = () => {
	try {
		process.stdout.write(CLEAR_TERMINAL_SEQUENCE);
	} catch {}
};

const restorePrimaryScreen = () => {
	// Blocking write(2) to fd 1 so the sequence is in the kernel PTY buffer before
	// process.exit. opentui's native teardown writes directly to fd 1 too, but it
	// never emits ?2026l — see RESTORE_PRIMARY_SCREEN_SEQUENCE for why that strands
	// Kitty on the alternate screen.
	try {
		writeSync(1, RESTORE_PRIMARY_SCREEN_SEQUENCE);
	} catch {}
};

const clearAlternateScreen = () => {
	try {
		writeSync(1, ALT_SCREEN_CLEAR_SEQUENCE);
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

const STATS_PALETTE = {
	border: "#334155",
	surface: "#0F172A",
	title: "#E2E8F0",
	label: "#94A3B8",
	value: "#F1F5F9",
	hint: "#64748B",
};

const createStatsModalContent = (state: AppState, modalWidth: number) => {
	const sourceCounts = countSessionsBySource(state.allSessions);
	const statusCounts: Partial<Record<string, number>> = {};
	for (const session of state.allSessions) {
		const s = session.status ?? "unknown";
		statusCounts[s] = (statusCounts[s] ?? 0) + 1;
	}
	const sourceRows = (
		[
			"opencode",
			"codex",
			"claude",
			"pi",
			"omp",
			"gjc",
			"mission-control",
		] as const
	)
		.map((sourceKey) => {
			const count = sourceCounts[sourceKey] ?? 0;
			return count > 0
				? Text({
						content: t`  ${getSessionSourceLabel(sourceKey)}${dim(": ")}${String(count)}`,
						fg: STATS_PALETTE.value,
						width: "100%",
					})
				: null;
		})
		.filter((v): v is ReturnType<typeof Text> => v !== null);

	const statusRows = (
		[
			["running", statusCounts.running ?? 0],
			["waiting", statusCounts.waiting ?? 0],
			["completed", statusCounts.completed ?? 0],
			["failed", statusCounts.failed ?? 0],
			["unknown", statusCounts.unknown ?? 0],
		] as const
	)
		.filter(([, count]) => count > 0)
		.map(([label, count]) =>
			Text({
				content: t`  ${dim(`${label}: `)}${String(count)}`,
				fg: STATS_PALETTE.value,
				width: "100%",
			}),
		);

	return Box(
		{
			width: modalWidth,
			border: true,
			borderColor: STATS_PALETTE.border,
			backgroundColor: STATS_PALETTE.surface,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		},
		Text({
			content: t`${bold(fg(STATS_PALETTE.title)("Session Stats"))}`,
			width: "100%",
		}),
		Text({
			content: t`${dim("total: ")}${String(state.allSessions.length)}`,
			fg: STATS_PALETTE.value,
			width: "100%",
		}),
		...(sourceRows.length > 0
			? [
					Text({
						content: t`${dim("by source")}`,
						fg: STATS_PALETTE.label,
						width: "100%",
					}),
					...sourceRows,
				]
			: []),
		...(statusRows.length > 0
			? [
					Text({
						content: t`${dim("by status")}`,
						fg: STATS_PALETTE.label,
						width: "100%",
					}),
					...statusRows,
				]
			: []),
		Text({ content: "", height: 0 }),
		Text({
			content: t`${dim("Press Esc or Ctrl+S to close")}`,
			fg: STATS_PALETTE.hint,
			width: "100%",
		}),
	);
};

const createKillChildrenConfirmationDialog = (params: {
	sessionTitle: string;
	sessionId: string;
	summary: string;
	width: number;
	isKilling: boolean;
	errorMessage: string | null;
}) => {
	const targetLabel = params.summary;
	const heading = params.isKilling
		? "Stopping stuck/active sessions"
		: "Stop stuck/active sessions";
	const body = params.isKilling
		? `Stopping ${targetLabel}. Please wait.`
		: `Stop ${targetLabel}? Order: abort API → stop message → delete confirmation if both fail.`;
	const hint = params.isKilling
		? "The session list will refresh automatically when done."
		: "Press y to stop. Press Esc or n to cancel.";

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
	notice: string | null;
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
		...(params.notice
			? [
					Text({
						content: params.notice,
						fg: APP_PALETTE.warning,
						width: "100%",
						wrapMode: "word",
					}),
				]
			: []),
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
			content: t`${dim("Progress: ")}${fg(APP_PALETTE.accent)(`${params.confirmedCount} confirmed`)}${dim(", ")}${fg(APP_PALETTE.muted)(`${Math.max(params.currentIndex - 1 - params.confirmedCount, 0)} skipped`)}`,
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

	patchTextBufferViewSelection();

	const state: AppState = {
		allSessions: [],
		sessions: [],
		selectedIndex: -1,
		selectedSessionId: null,
		externalAttachedSessionIds: new Set(),
		externalAttachedSessionDirectoryCounts: new Map(),
		pendingDeleteTarget: null,
		deleteConfirmationError: null,
		pendingKillSessionId: null,
		pendingKillChildrenCount: 0,
		pendingKillIncludesSelected: false,
		pendingKillSummary: null,
		isKillingChildren: false,
		killChildrenError: null,
		killFallbackRemaining: [],
		killFallbackConfirmed: [],
		killFallbackCurrentIndex: 0,
		killFallbackNotice: null,
		missionControlFallbackPlan: null,
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
		isStatsModalVisible: false,
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
	// node v24 rejects new Worker(fileUrl.href string) with ERR_WORKER_PATH;
	// it requires the URL object (or a ./ relative path), not the .href string.
	const createRefreshWorker = (): Worker => {
		const worker = new Worker(new URL(`./db/refresh-worker`, import.meta.url), {
			execArgv: ["--experimental-sqlite", "--no-warnings"],
		});
		worker.unref();
		return worker;
	};
	let currentRefreshWorker: RefreshWorkerLifecycle | null = null;
	let refreshDispatchGateOpen = false;
	let refreshGeneration = 0;
	let isShuttingDown = false;
	const isResizeDebouncing: { value: ReturnType<typeof setTimeout> | null } = {
		value: null,
	};
	let interval: ReturnType<typeof setInterval> | null = null;
	let attachedSignalInterval: ReturnType<typeof setInterval> | null = null;
	let isRefreshingExternalAttachedSessions = false;
	let pendingSelectionRefreshResponse: RefreshResponse | null = null;
	let pendingSelectionRender = false;
	let lastRefreshRenderSignature: string | null = null;

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

		// Direct /proc scan — 4x faster than spawning `ps -eo pid,comm,args`.
		// Produces the same "PID COMM ARGS" line format that the parser expects.
		let processListOutput: string;
		try {
			const procEntries = readdirSync("/proc");
			const lines: string[] = [];
			for (const entry of procEntries) {
				if (!/^\d+$/u.test(entry)) {
					continue;
				}

				try {
					const comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim();
					if (!comm || !isSessionProcessComm(comm)) {
						continue;
					}

					const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
						.replace(/\0/gu, " ")
						.trim();
					if (!cmdline) {
						continue;
					}

					lines.push(`${entry} ${comm} ${cmdline}`);
				} catch {}
			}
			processListOutput = lines.join("\n");
		} catch {
			return {
				sessionIds: new Set(),
				directoryProcessCounts: new Map(),
			};
		}

		return parseAttachedSessionIdsFromProcessList(processListOutput, (pid) => {
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
		const attachEnvironment = getAttachLaunchEnvironment(attachLaunchSpec);
		writeAttachDebug("run:start", {
			cmd: attachLaunchSpec.cmd,
			cwd: attachLaunchSpec.cwd,
			path: attachEnvironment.PATH,
			stdinTTY: process.stdin.isTTY,
			stdoutTTY: process.stdout.isTTY,
			platform: process.platform,
		});

		const child = spawn(
			attachLaunchSpec.cmd[0],
			attachLaunchSpec.cmd.slice(1),
			{
				cwd: attachLaunchSpec.cwd,
				env: attachEnvironment,
				stdio: "inherit",
			},
		);
		writeAttachDebug("run:spawn", { pid: child.pid, mode: "inherit" });

		const exitCode = await new Promise<number>((resolve, reject) => {
			child.on("close", (code) => resolve(code ?? 1));
			child.on("error", reject);
		});
		writeAttachDebug("run:exit", { exitCode, mode: "inherit" });
		return exitCode;
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
		render();
	};

	const handleDetailMouseDown = (
		event: Parameters<typeof handleDetailMouseDownEvent>[0],
	) =>
		handleDetailMouseDownEvent(event, {
			isDetailMode: state.isDetailMode,
			isSideviewMode: state.isSideviewMode,
			setFocusedPane,
			closeDetailView,
		});

	const stopPolling = () => {
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
		if (attachedSignalInterval) {
			clearInterval(attachedSignalInterval);
			attachedSignalInterval = null;
		}
	};

	const startPolling = () => {
		if (!refreshDispatchGateOpen || isShuttingDown) {
			return;
		}

		if (!interval) {
			interval = setInterval(() => {
				refreshSessions();
			}, POLL_INTERVAL_MS);
		}
		if (!attachedSignalInterval) {
			attachedSignalInterval = setInterval(() => {
				void refreshExternalAttachedSessionSignals();
			}, ATTACHED_SIGNAL_INTERVAL_MS);
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
					Box(
						{
							id: DETAIL_CONTAINER_ID,
							width: 0,
							height: "100%",
							border: true,
							borderColor: "#334155",
							backgroundColor: "#0F172A",
							overflow: "hidden",
							visible: false,
							onMouseDown: handleDetailMouseDown,
							onMouseScroll: (event) => {
								event.preventDefault();
								event.stopPropagation();
								handlePaneMouseScroll("detail", event.scroll?.direction);
							},
						},
						ScrollBox(
							{
								id: DETAIL_SCROLLBOX_ID,
								width: "100%",
								height: "100%",
								margin: 2,
								backgroundColor: "#0F172A",
								wrapperOptions: { padding: DETAIL_SCROLLBOX_WRAPPER_PADDING },
								onMouseDown: handleDetailMouseDown,
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
						Box({
							id: DETAIL_FRAME_OVERLAY_ID,
							position: "absolute",
							top: 0,
							left: 0,
							width: 0,
							height: 0,
							visible: false,
							border: false,
							borderColor: "#334155",
							backgroundColor: "transparent",
							shouldFill: false,
							zIndex: 10,
						}),
					),
					Box(
						{
							id: HIERARCHY_CONTAINER_ID,
							width: 0,
							height: "100%",
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
								wrapperOptions: { padding: 1 },
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
						Box({
							id: HIERARCHY_FRAME_OVERLAY_ID,
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: "100%",
							border: true,
							borderColor: "#334155",
							backgroundColor: "transparent",
							shouldFill: false,
							zIndex: 10,
						}),
						Box({
							position: "absolute",
							top: -1,
							left: 0,
							width: "100%",
							height: 1,
							backgroundColor: APP_PALETTE.bg,
							zIndex: 20,
						}),
						Box({
							position: "absolute",
							bottom: -1,
							left: 0,
							width: "100%",
							height: 1,
							backgroundColor: APP_PALETTE.bg,
							zIndex: 20,
						}),
					),
				),
				Box(
					{
						id: FOOTER_CONTAINER_ID,
						width: "100%",
						flexDirection: "column",
						gap: 0,
						backgroundColor: APP_PALETTE.bg,
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

		renderer.root.add(
			Box({
				id: STATS_OVERLAY_ID,
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 70,
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
		const existingDetailContainer =
			renderer.root.findDescendantById(DETAIL_CONTAINER_ID);
		const existingDetailFrameOverlay = renderer.root.findDescendantById(
			DETAIL_FRAME_OVERLAY_ID,
		);
		const existingDetailScrollBox =
			renderer.root.findDescendantById(DETAIL_SCROLLBOX_ID);
		const existingHierarchyContainer = renderer.root.findDescendantById(
			HIERARCHY_CONTAINER_ID,
		);
		const existingHierarchyFrameOverlay = renderer.root.findDescendantById(
			HIERARCHY_FRAME_OVERLAY_ID,
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
		const statsOverlay = renderer.root.findDescendantById(STATS_OVERLAY_ID);
		const activeDetailSessionId = state.renderedDetailSessionId;

		if (
			!isBoxRenderable(existingRoot) ||
			!isScrollBoxRenderable(existingGridScrollBox) ||
			!isBoxRenderable(existingDetailContainer) ||
			!isBoxRenderable(existingDetailFrameOverlay) ||
			!isScrollBoxRenderable(existingDetailScrollBox) ||
			!isBoxRenderable(existingHierarchyContainer) ||
			!isBoxRenderable(existingHierarchyFrameOverlay) ||
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
			!isBoxRenderable(deleteConfirmationOverlay) ||
			!isBoxRenderable(statsOverlay)
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
			state.pendingDeleteTarget || state.pendingKillSessionId,
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
				? "↑/↓/PgUp/PgDn: scroll | ←/→: pan timeline"
				: "↑/↓/PgUp/PgDn: scroll";
		const selectedSessionForActions =
			state.sessions[state.selectedIndex] ?? null;
		const canAttachSelected = canAttachToSession(selectedSessionForActions);
		const canDeleteSelected = canDeleteSession(selectedSessionForActions);
		const selectedAbortPlan =
			selectedSessionForActions &&
			canAbortSessionChildren(selectedSessionForActions)
				? getAbortTargets(selectedSessionForActions)
				: null;
		const canAbortChildrenSelected =
			(selectedAbortPlan?.targets.length ?? 0) > 0;
		const shortcutGuide = deletePromptActive
			? state.pendingDeleteTarget
				? state.isDeletingSession
					? "Deleting selected session..."
					: "Delete selected session? y: confirm | Esc/n: cancel"
				: state.isKillingChildren
					? "Deleting confirmed sessions..."
					: state.killFallbackRemaining.length > 0
						? "Delete child? y: delete | n: skip | Esc: cancel all"
						: "Stop stuck/active sessions? y: confirm | Esc/n: cancel"
			: state.isHierarchyMode
				? `Tab: view(${hierarchyViewLabel}) | x: info(${state.hierarchyInfoMode}) | f: filter(${hierarchyFilterLabel}) | ${hierarchyScrollHint} | q/Esc: close`
				: state.focusedPane === "detail"
					? `${FILTER_SHORTCUT_LABEL}/click: filter(${sessionFilterLabel}) | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}${TIMELINE_SHORTCUT_LABEL}: timeline | ↑/↓/PgUp/PgDn: scroll detail | ${HIERARCHY_SHORTCUT_LABEL}: hierarchy${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: stop stuck` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""} | ${COPY_ID_SHORTCUT_LABEL}: copy id${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""} | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | Ctrl+S: stats | q/Esc: quit`
					: `${FILTER_SHORTCUT_LABEL}/click: filter(${sessionFilterLabel}) | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}arrows/PgUp/PgDn: move grid | Enter: detail | ${TIMELINE_SHORTCUT_LABEL}: timeline | ${HIERARCHY_SHORTCUT_LABEL}: hierarchy${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: stop stuck` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""} | ${COPY_ID_SHORTCUT_LABEL}: copy id${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""} | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | Ctrl+S: stats | q/Esc: quit`;
		const styledShortcutGuide = deletePromptActive
			? state.pendingDeleteTarget
				? state.isDeletingSession
					? t`${fg(APP_PALETTE.warning)("Deleting selected session...")}`
					: t`${fg(APP_PALETTE.danger)("Delete selected session? ")}${footerShortcut("y")}${dim(": confirm | ")}${footerShortcut("Esc/n")}${dim(": cancel")}`
				: state.isKillingChildren
					? t`${fg(APP_PALETTE.warning)("Deleting confirmed sessions...")}`
					: state.killFallbackRemaining.length > 0
						? t`${fg(APP_PALETTE.danger)("Delete child? ")}${footerShortcut("y")}${dim(": delete | ")}${footerShortcut("n")}${dim(": skip | ")}${footerShortcut("Esc")}${dim(": cancel all")}`
						: t`${fg(APP_PALETTE.warning)("Stop stuck/active sessions? ")}${footerShortcut("y")}${dim(": confirm | ")}${footerShortcut("Esc/n")}${dim(": cancel")}`
			: state.isHierarchyMode
				? effectiveHierarchyViewMode === "flow"
					? t`${footerShortcut("Tab")}${dim(": view(")}${footerState(hierarchyViewLabel)}${dim(") | ")}${footerShortcut("x")}${dim(": info(")}${footerState(state.hierarchyInfoMode)}${dim(") | ")}${footerShortcut("f")}${dim(": filter(")}${footerState(hierarchyFilterLabel)}${dim(") | ")}${footerShortcut("↑/↓/PgUp/PgDn")}${dim(": scroll | ")}${footerShortcut("←/→")}${dim(": pan timeline | ")}${footerShortcut("q/Esc")}${dim(": close")}`
					: t`${footerShortcut("Tab")}${dim(": view(")}${footerState(hierarchyViewLabel)}${dim(") | ")}${footerShortcut("x")}${dim(": info(")}${footerState(state.hierarchyInfoMode)}${dim(") | ")}${footerShortcut("f")}${dim(": filter(")}${footerState(hierarchyFilterLabel)}${dim(") | ")}${footerShortcut("↑/↓/PgUp/PgDn")}${dim(": scroll | ")}${footerShortcut("q/Esc")}${dim(": close")}`
				: state.focusedPane === "detail"
					? t`${footerShortcut(FILTER_SHORTCUT_LABEL)}${dim("/click: filter(")}${footerState(sessionFilterLabel)}${dim(") | ")}${footerShortcut(SORT_SHORTCUT_LABEL)}${dim(": sort(")}${footerState(state.sessionSortMode)}${dim(") | ")}${canSwitchFocus ? footerShortcut("Tab") : ""}${canSwitchFocus ? dim(": switch pane | ") : ""}${footerShortcut(TIMELINE_SHORTCUT_LABEL)}${dim(": timeline | ")}${footerShortcut("↑/↓/PgUp/PgDn")}${dim(": scroll detail | ")}${footerShortcut(HIERARCHY_SHORTCUT_LABEL)}${dim(": hierarchy")}${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: stop stuck` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""}${dim(" | ")}${footerShortcut(COPY_ID_SHORTCUT_LABEL)}${dim(": copy id")}${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""}${dim(" | ")}${footerShortcut(SIDEVIEW_SHORTCUT_LABEL)}${dim(": sideview | ")}${footerShortcut("q/Esc")}${dim(": quit")}`
					: t`${footerShortcut(FILTER_SHORTCUT_LABEL)}${dim("/click: filter(")}${footerState(sessionFilterLabel)}${dim(") | ")}${footerShortcut(SORT_SHORTCUT_LABEL)}${dim(": sort(")}${footerState(state.sessionSortMode)}${dim(") | ")}${canSwitchFocus ? footerShortcut("Tab") : ""}${canSwitchFocus ? dim(": switch pane | ") : ""}${footerShortcut("arrows/PgUp/PgDn")}${dim(": move grid | ")}${footerShortcut("Enter")}${dim(": detail | ")}${footerShortcut(TIMELINE_SHORTCUT_LABEL)}${dim(": timeline | ")}${footerShortcut(HIERARCHY_SHORTCUT_LABEL)}${dim(": hierarchy")}${canAbortChildrenSelected ? ` | ${KILL_CHILDREN_SHORTCUT_LABEL}: stop stuck` : ""}${canAttachSelected ? ` | ${ATTACH_SHORTCUT_LABEL}: attach` : ""}${dim(" | ")}${footerShortcut(COPY_ID_SHORTCUT_LABEL)}${dim(": copy id")}${canDeleteSelected ? ` | ${DELETE_SHORTCUT_LABEL}: delete` : ""}${dim(" | ")}${footerShortcut(SIDEVIEW_SHORTCUT_LABEL)}${dim(": sideview | ")}${footerShortcut("q/Esc")}${dim(": quit")}`;
		const footerAvailableWidth = innerWidth;
		const operationalFooterText =
			state.dbError ??
			(state.pendingKillSessionId
				? state.isKillingChildren
					? "deleting sessions..."
					: state.killFallbackRemaining.length > 0
						? `delete confirm: ${state.killFallbackCurrentIndex + 1}/${state.killFallbackRemaining.length}`
						: `stop armed: ${state.pendingKillSummary ?? `${state.pendingKillChildrenCount} targets`}`
				: deletePromptActive
					? state.isDeletingSession
						? "delete in progress"
						: `delete armed: ${state.pendingDeleteTarget?.title ?? "selected session"}`
					: `${focusSummary}${hiddenCompletedSummary}`);
		const rightFooterText = `${operationalFooterText} | ${FRESHNESS_DISCLOSURE}`;
		const rightFooterLineCount = getWrappedTerminalLineCount(
			rightFooterText,
			footerAvailableWidth,
		);
		const controlFooterLineCount = getWrappedTerminalLineCount(
			shortcutGuide,
			footerAvailableWidth,
		);
		const footerWraps =
			getConservativeTerminalCellWidth(shortcutGuide) +
				getConservativeTerminalCellWidth(rightFooterText) +
				FOOTER_INLINE_GAP >
			footerAvailableWidth;
		const footerHeight = footerWraps
			? controlFooterLineCount + rightFooterLineCount
			: 1;
		const rightFooterWidth = Math.min(
			getConservativeTerminalCellWidth(rightFooterText),
			footerAvailableWidth,
		);
		const leftFooterWidth = Math.max(
			footerAvailableWidth - rightFooterWidth - FOOTER_INLINE_GAP,
			1,
		);
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

		const styledOperationalFooter = state.dbError
			? t`${fg(APP_PALETTE.warning)(state.dbError)}`
			: state.pendingKillSessionId
				? state.isKillingChildren
					? t`${fg(APP_PALETTE.warning)("deleting sessions...")}`
					: state.killFallbackRemaining.length > 0
						? t`${fg(APP_PALETTE.danger)("delete confirm")}${dim(": ")}${footerState(`${state.killFallbackCurrentIndex + 1}/${state.killFallbackRemaining.length}`)}`
						: t`${fg(APP_PALETTE.warning)("stop armed")}${dim(": ")}${footerState(state.pendingKillSummary ?? `${state.pendingKillChildrenCount} targets`)}`
				: deletePromptActive
					? state.isDeletingSession
						? t`${fg(APP_PALETTE.warning)("delete in progress")}`
						: t`${fg(APP_PALETTE.danger)("delete armed")}${dim(": ")}${footerState(state.pendingDeleteTarget?.title ?? "selected session")}`
					: t`${dim(headerText)}${canSwitchFocus ? dim(" | sort: ") : ""}${canSwitchFocus ? footerState(state.sessionSortMode) : ""}${canSwitchFocus ? dim(" | focus: ") : ""}${canSwitchFocus ? footerState(focusLabel) : ""}${shouldShowHiddenCompleted && state.hiddenCompletedCount > 0 ? dim(" | hidden completed: ") : ""}${shouldShowHiddenCompleted && state.hiddenCompletedCount > 0 ? footerState(state.hiddenCompletedCount.toLocaleString("en-US")) : ""}`;

		statusText.width = footerWraps ? footerAvailableWidth : rightFooterWidth;
		statusText.height = footerWraps ? rightFooterLineCount : 1;
		statusText.wrapMode = footerWraps ? "char" : "none";
		statusText.content = new StyledText([
			...styledOperationalFooter.chunks,
			dim(` | ${FRESHNESS_DISCLOSURE}`),
		]);
		statusText.truncate = !footerWraps;

		controlText.width = footerWraps ? footerAvailableWidth : leftFooterWidth;
		controlText.height = footerWraps ? controlFooterLineCount : 1;
		controlText.wrapMode = footerWraps ? "char" : "none";
		controlText.content = styledShortcutGuide;
		controlText.truncate = !footerWraps;

		footerContainer.width = footerAvailableWidth;
		footerContainer.height = footerHeight;
		footerContainer.backgroundColor = APP_PALETTE.bg;
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

		const detailPaneWidth = showDetail
			? detailOnlyMode
				? innerWidth
				: detailWidth
			: 0;
		const detailScrollBoxWidth = Math.max(detailPaneWidth - 4, 1);
		const detailVerticalScrollbarWidth = showDetail
			? Math.max(
					getSafeNumber(
						existingDetailScrollBox.verticalScrollBar.width,
						DETAIL_SCROLLBOX_SCROLLBAR_WIDTH,
					),
					DETAIL_SCROLLBOX_SCROLLBAR_WIDTH,
				)
			: 0;
		const detailContentWidth = getDetailPanelContentWidth(
			detailScrollBoxWidth,
			DETAIL_SCROLLBOX_WRAPPER_PADDING,
			detailVerticalScrollbarWidth,
		);

		existingDetailContainer.visible = showDetail;
		existingDetailContainer.width = detailPaneWidth;
		existingDetailContainer.height = contentHeight;
		existingDetailContainer.borderColor =
			showDetail && state.focusedPane === "detail"
				? APP_PALETTE.accent
				: "#334155";

		existingDetailFrameOverlay.visible = false;
		existingDetailFrameOverlay.width = 0;
		existingDetailFrameOverlay.height = 0;

		existingDetailScrollBox.visible = showDetail;
		existingDetailScrollBox.width = detailScrollBoxWidth;
		existingDetailScrollBox.height = Math.max(contentHeight - 6, 1);

		existingHierarchyContainer.visible = showHierarchy;
		existingHierarchyContainer.width = showHierarchy ? innerWidth : 0;
		existingHierarchyContainer.height = contentHeight;

		existingHierarchyFrameOverlay.visible = showHierarchy;
		existingHierarchyFrameOverlay.width = "100%";
		existingHierarchyFrameOverlay.height = "100%";
		existingHierarchyFrameOverlay.borderColor = showHierarchy
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
					scrollTop: state.gridScrollTop,
					viewportHeight: getSafeNumber(existingGridScrollBox.height, 0),
				}),
			]);
		} else if (gridContent.getChildren().length > 0) {
			replaceChildren(gridContent, []);
		}

		if (showDetail) {
			const detailPanelContent = createDetailPanelContent({
				session: selectedSession,
				messageCount: selectedSession?.id
					? state.messageCountBySessionId[selectedSession.id]
					: undefined,
				sessions: state.allSessions,
				messageCountBySessionId: state.messageCountBySessionId,
				status: selectedState.status,
				summary: selectedState.summary,
				width: detailContentWidth,
			});
			normalizeDetailSectionBorders(detailPanelContent);
			replaceChildren(detailContent, [detailPanelContent]);
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
			deletePromptActive && state.pendingDeleteTarget
				? [
						createDeleteConfirmationDialog({
							title: state.pendingDeleteTarget.title,
							sessionId: state.pendingDeleteTarget.id,
							width: Math.min(Math.max(width - 8, 36), 72),
							isDeleting: state.isDeletingSession,
							errorMessage: state.deleteConfirmationError,
							sourceLabel: getSessionSourceLabel(
								state.pendingDeleteTarget.source,
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
								notice: state.killFallbackNotice,
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
									summary:
										state.pendingKillSummary ??
										`${state.pendingKillChildrenCount} child session${state.pendingKillChildrenCount === 1 ? "" : "s"}`,
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

		statsOverlay.visible = state.isStatsModalVisible;
		statsOverlay.width = width;
		statsOverlay.height = height;
		replaceChildren(
			statsOverlay,
			state.isStatsModalVisible
				? [
						createStatsModalContent(
							state,
							Math.min(Math.max(width - 8, 36), 72),
						),
					]
				: [],
		);

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
		state.gridFollowSelectionOnRender = false;
	};

	const applyRefreshErrorState = (errorMessage: string) => {
		lastRefreshRenderSignature = null;
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

		const orderedSettledSessions = snapshot.sessions
			.filter((session) => isSettledSession(session))
			.sort((left, right) => right.time_updated - left.time_updated);
		const latestCompletedSessionId = orderedSettledSessions[0]?.id ?? null;

		const getAttachedDirectoryKey = (
			session: (typeof snapshot.sessions)[number],
		) =>
			getExternalAttachedDirectoryKey(
				session.sessionSource,
				normalizeDirectoryPath(session.directory),
			);

		const externalDirectoryPinnedSessionIds = selectDirectoryPinnedSessionIds({
			sessions: snapshot.sessions,
			directoryProcessCounts: state.externalAttachedSessionDirectoryCounts,
			getDirectoryKey: getAttachedDirectoryKey,
		});

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

		const nextRefreshRenderSignature = createRefreshRenderSignature({
			snapshot,
			sessionFilterMode: state.sessionFilterMode,
			sessionSortMode: state.sessionSortMode,
			selectedSessionId: state.selectedSessionId,
			externalAttachedSessionIds: state.externalAttachedSessionIds,
			externalAttachedSessionDirectoryCounts:
				state.externalAttachedSessionDirectoryCounts,
		});
		if (nextRefreshRenderSignature === lastRefreshRenderSignature) {
			state.gridFollowSelectionOnRender = false;
			return;
		}
		lastRefreshRenderSignature = nextRefreshRenderSignature;
		render();
	};

	const dispatchRefreshRequest = (requestId: RefreshRequestId): boolean => {
		const worker = currentRefreshWorker;
		if (!worker) {
			return false;
		}

		return postRefresh(worker, createRequest(requestId, refreshGeneration));
	};

	const completeRefreshRequest = (requestId: RefreshRequestId) => {
		const nextRequestId = refreshCoordinator.completeRefresh(requestId);

		if (nextRequestId !== null && refreshDispatchGateOpen) {
			dispatchRefreshRequest(nextRequestId);
		}
	};

	const settleRefreshWaiters = (response: RefreshResponse) => {
		refreshCoordinator.settleRefresh(
			response.requestId,
			response.ok
				? { ok: true }
				: {
						ok: false,
						error: new RefreshCompletionError(response.error.message),
					},
		);
	};

	const hasActiveTextSelection = (): boolean => {
		return isTextSelectionInProgress(renderer.getSelection());
	};

	const applyRefreshResponseState = (response: RefreshResponse) => {
		if (renderStats) renderStats.applyTriggeredRenders++;

		if (!response.ok) {
			applyRefreshErrorState(response.error.message);
			return;
		}

		applyRefreshSnapshotState(response.snapshot);
	};

	const applyPendingSelectionRefresh = (): boolean => {
		if (!pendingSelectionRefreshResponse || hasActiveTextSelection()) {
			return false;
		}

		const response = pendingSelectionRefreshResponse;
		pendingSelectionRefreshResponse = null;
		if (
			response.generation !== refreshGeneration ||
			!refreshCoordinator.shouldApplyResponse(response.requestId)
		) {
			settleRefreshWaiters(response);
			return true;
		}

		applyRefreshResponseState(response);
		settleRefreshWaiters(response);
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
		const selection = renderer.getSelection();
		if (!selection || hasActiveTextSelection()) {
			return false;
		}

		renderer.clearSelection();
		applyPendingSelectionWork();
		return true;
	};

	const copyCompletedTextSelection = (): boolean => {
		const selection = renderer.getSelection();
		if (!selection || hasActiveTextSelection()) {
			return false;
		}

		const selectedText = getTextSelectionText(selection);
		if (!selectedText) {
			return clearCompletedTextSelection();
		}

		renderer.copyToClipboardOSC52(selectedText);
		renderer.clearSelection();
		applyPendingSelectionWork();
		showToast("Copied selected text to clipboard");
		return true;
	};

	const handleRefreshResponse = (
		instance: RefreshWorkerLifecycle,
		response: RefreshResponse,
	) => {
		if (
			instance !== currentRefreshWorker ||
			response.generation !== refreshGeneration
		) {
			return;
		}

		try {
			if (!refreshCoordinator.shouldApplyResponse(response.requestId)) {
				return;
			}

			if (hasActiveTextSelection()) {
				pendingSelectionRefreshResponse = response;
				return;
			}

			applyRefreshResponseState(response);
			settleRefreshWaiters(response);
		} finally {
			completeRefreshRequest(response.requestId);
		}
	};

	const rejectControlWaiter = (
		instance: RefreshWorkerLifecycle,
		error: Error,
	) => {
		const waiter = instance.resetWaiter;
		instance.resetWaiter = null;
		waiter?.reject(error);
	};

	const createPromiseResolvers = <T>() => {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		return { promise, resolve, reject };
	};

	const waitForControlAcknowledgement = (
		instance: RefreshWorkerLifecycle,
		kind: RefreshWorkerControlKind,
		generation: number,
	): Promise<void> => {
		const { promise, resolve, reject } = createPromiseResolvers<void>();
		instance.resetWaiter = { kind, generation, resolve, reject };
		return promise;
	};

	const handleControlAcknowledgement = (
		instance: RefreshWorkerLifecycle,
		acknowledgement: RefreshWorkerControlAcknowledgement,
	) => {
		if (
			instance !== currentRefreshWorker ||
			acknowledgement.generation !== refreshGeneration
		) {
			return;
		}

		const waiter = instance.resetWaiter;
		const expectedKind =
			waiter?.kind === "ready"
				? "refresh-worker-ready-ack"
				: "refresh-reset-ack";
		if (
			!waiter ||
			waiter.generation !== acknowledgement.generation ||
			acknowledgement.kind !== expectedKind ||
			(instance.status !== "starting" && instance.status !== "resetting")
		) {
			return;
		}

		instance.resetWaiter = null;
		instance.status = "usable";
		waiter.resolve();
	};

	function failCurrentWorker(
		instance: RefreshWorkerLifecycle,
		reason: string,
		fromExit = false,
	): Promise<void> {
		if (instance !== currentRefreshWorker) {
			return instance.retirementPromise ?? Promise.resolve();
		}
		if (instance.retirementPromise) {
			return instance.retirementPromise;
		}

		refreshDispatchGateOpen = false;
		instance.status = "retiring";
		refreshGeneration += 1;
		stopPolling();
		pendingSelectionRefreshResponse = null;
		pendingSelectionRender = false;
		const failure = new RefreshCompletionError(reason);
		refreshCoordinator.cancel(failure);
		rejectControlWaiter(instance, failure);
		state.dbError = reason;
		render();

		const { promise: retirementPromise, resolve: resolveRetirement } =
			createPromiseResolvers<void>();
		instance.retirementPromise = retirementPromise;

		void (async () => {
			try {
				if (!fromExit) {
					instance.worker.removeAllListeners();
					await instance.worker.terminate();
				}
			} catch (error) {
				instance.status = "failed";
				state.dbError = `Refresh worker recovery stopped: ${error instanceof Error ? error.message : "worker termination failed."}`;
				render();
				return;
			}

			if (isShuttingDown || instance !== currentRefreshWorker) {
				return;
			}

			instance.status = "failed";
			await recoverWorker(instance, reason);
		})().finally(() => {
			resolveRetirement();
		});

		return retirementPromise;
	}

	const postToCurrentWorker = (
		instance: RefreshWorkerLifecycle,
		message: RefreshWorkerRequest,
		purpose: "refresh" | "control",
	): boolean => {
		if (instance !== currentRefreshWorker) {
			return false;
		}

		const canPost =
			purpose === "refresh"
				? instance.status === "usable" && refreshDispatchGateOpen
				: instance.status === "starting" || instance.status === "resetting";
		if (!canPost) {
			void failCurrentWorker(
				instance,
				`Refresh worker rejected an invalid ${purpose} dispatch.`,
			);
			return false;
		}

		try {
			instance.worker.postMessage(message);
			return true;
		} catch (error) {
			void failCurrentWorker(
				instance,
				error instanceof Error
					? error.message
					: `Failed to post ${purpose} request to refresh worker.`,
			);
			return false;
		}
	};

	const postRefresh = (
		instance: RefreshWorkerLifecycle,
		request: RefreshRequest,
	): boolean => postToCurrentWorker(instance, request, "refresh");

	const postControl = (
		instance: RefreshWorkerLifecycle,
		request: RefreshResetRequest | RefreshWorkerReadyRequest,
	): boolean => postToCurrentWorker(instance, request, "control");

	const sendControlAndWait = (
		instance: RefreshWorkerLifecycle,
		kind: RefreshWorkerControlKind,
		generation: number,
	): Promise<void> => {
		const acknowledgement = waitForControlAcknowledgement(
			instance,
			kind,
			generation,
		);
		const request =
			kind === "ready"
				? createRefreshWorkerReadyRequest(generation)
				: createRefreshResetRequest(generation);
		if (!postControl(instance, request)) {
			rejectControlWaiter(
				instance,
				new RefreshCompletionError(
					`Failed to dispatch refresh worker ${kind} control request.`,
				),
			);
		}
		return acknowledgement;
	};

	const handleCurrentWorkerMessage = (
		instance: RefreshWorkerLifecycle,
		message: unknown,
	) => {
		if (instance !== currentRefreshWorker) {
			return;
		}

		if (isRefreshWorkerControlAcknowledgement(message)) {
			handleControlAcknowledgement(instance, message);
			return;
		}

		if (isRefreshResponse(message)) {
			handleRefreshResponse(instance, message);
		}
	};

	const attachWorkerHandlers = (instance: RefreshWorkerLifecycle) => {
		instance.worker.on("message", (message: unknown) => {
			handleCurrentWorkerMessage(instance, message);
		});
		instance.worker.on("messageerror", () => {
			void failCurrentWorker(
				instance,
				"Failed to deserialize refresh worker response payload.",
			);
		});
		instance.worker.on("error", (error: Error) => {
			void failCurrentWorker(
				instance,
				error.message || "Refresh worker encountered an unexpected error.",
			);
		});
		instance.worker.on("exit", (code) => {
			if (!isShuttingDown) {
				void failCurrentWorker(
					instance,
					`Refresh worker exited unexpectedly${code === 0 ? "." : ` with code ${code}.`}`,
					true,
				);
			}
		});
	};

	const installAndReadyWorker = async (): Promise<void> => {
		let instance: RefreshWorkerLifecycle;
		try {
			instance = {
				worker: createRefreshWorker(),
				status: "starting",
				resetWaiter: null,
				retirementPromise: null,
				recoveryPromise: null,
			};
		} catch (error) {
			state.dbError = `Refresh worker startup failed: ${error instanceof Error ? error.message : "worker construction failed."}`;
			render();
			return;
		}

		currentRefreshWorker = instance;
		attachWorkerHandlers(instance);
		try {
			await sendControlAndWait(instance, "ready", refreshGeneration);
			if (
				isShuttingDown ||
				instance !== currentRefreshWorker ||
				instance.status !== "usable"
			) {
				return;
			}

			refreshDispatchGateOpen = true;
			state.dbError = null;
			lastRefreshRenderSignature = null;
			render();
			pendingSelectionRender = false;
			void refreshSessionsAndWait().then(startPolling, startPolling);
		} catch (error) {
			if (instance === currentRefreshWorker && instance.status !== "retiring") {
				void failCurrentWorker(
					instance,
					error instanceof Error
						? error.message
						: "Refresh worker readiness check failed.",
				);
			}
		}
	};

	function recoverWorker(
		failedInstance: RefreshWorkerLifecycle,
		_reason: string,
	): Promise<void> {
		if (failedInstance.recoveryPromise) {
			return failedInstance.recoveryPromise;
		}

		const { promise: recoveryPromise, resolve: resolveRecovery } =
			createPromiseResolvers<void>();
		failedInstance.recoveryPromise = recoveryPromise;

		void installAndReadyWorker().finally(() => {
			resolveRecovery();
		});
		return recoveryPromise;
	}

	const resetWorkerForJsonlDelete = async (): Promise<void> => {
		const instance = currentRefreshWorker;
		if (instance?.status !== "usable") {
			throw new Error(
				"Refresh worker is not available for the Pi/omp/gjc delete reset.",
			);
		}

		refreshDispatchGateOpen = false;
		refreshGeneration += 1;
		stopPolling();
		pendingSelectionRefreshResponse = null;
		pendingSelectionRender = false;
		refreshCoordinator.cancel(
			new RefreshCompletionError(
				"Refresh canceled for Pi/omp/gjc session deletion.",
			),
		);
		instance.status = "resetting";
		await sendControlAndWait(instance, "reset", refreshGeneration);
		const resetStatus = instance.status as RefreshWorkerStatus;
		if (
			instance !== currentRefreshWorker ||
			resetStatus !== "usable" ||
			isShuttingDown
		) {
			throw new Error("Refresh worker reset did not complete.");
		}
	};

	const refreshSessions = () => {
		if (!refreshDispatchGateOpen) {
			return;
		}
		if (applyPendingSelectionWork() || !refreshDispatchGateOpen) {
			return;
		}

		const ticket = refreshCoordinator.requestRefresh();
		if (ticket.shouldDispatch) {
			dispatchRefreshRequest(ticket.requestId);
		}
	};

	const refreshSessionsAndWait = (): Promise<void> => {
		if (!refreshDispatchGateOpen) {
			return Promise.reject(
				new RefreshCompletionError(
					"Refresh dispatch is temporarily unavailable.",
				),
			);
		}

		applyPendingSelectionWork();
		if (!refreshDispatchGateOpen) {
			return Promise.reject(
				new RefreshCompletionError(
					"Refresh dispatch is temporarily unavailable.",
				),
			);
		}

		const ticket = refreshCoordinator.requestRefresh();
		const completion = refreshCoordinator.waitForRefresh(ticket.requestId);
		if (ticket.shouldDispatch) {
			dispatchRefreshRequest(ticket.requestId);
		}
		return completion;
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

	const getScrollPageDelta = (scrollBoxId: string): number => {
		const scrollBox = renderer.root.findDescendantById(scrollBoxId);
		if (!isScrollBoxRenderable(scrollBox) || !scrollBox.visible) {
			return DETAIL_SCROLL_STEP * 3;
		}

		return Math.max(
			getSafeNumber(scrollBox.height, DETAIL_SCROLL_STEP * 3) - 1,
			1,
		);
	};

	const scrollHierarchyPage = (direction: "up" | "down") => {
		const pageDelta = getScrollPageDelta(HIERARCHY_SCROLLBOX_ID);
		scrollHierarchy(direction === "up" ? -pageDelta : pageDelta);
	};

	const scrollDetailPage = (direction: "up" | "down") => {
		const pageDelta = getScrollPageDelta(DETAIL_SCROLLBOX_ID);
		scrollDetail(direction === "up" ? -pageDelta : pageDelta);
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

	const getGridLayoutMetrics = (): {
		columnCount: number;
		gridHeight: number;
	} => {
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
		const measuredGridHeight =
			isScrollBoxRenderable(gridScrollBox) && gridScrollBox.visible
				? Math.max(getSafeNumber(gridScrollBox.height, 1), 1)
				: Math.max(getSafeNumber(renderer.height, 24) - 6, 1);
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

		return {
			columnCount: renderedColumnCount,
			gridHeight: measuredGridHeight,
		};
	};

	const moveSelection = (direction: "left" | "right" | "up" | "down") => {
		if (state.sessions.length === 0) {
			return;
		}

		const { columnCount } = getGridLayoutMetrics();

		const nextIndex = moveSelectionInGrid({
			sessions: state.sessions,
			selectedIndex: state.selectedIndex < 0 ? 0 : state.selectedIndex,
			columnCount,
			direction,
		});

		if (nextIndex !== state.selectedIndex) {
			state.selectedIndex = nextIndex;
			state.selectedSessionId = state.sessions[nextIndex]?.id ?? null;
			state.gridFollowSelectionOnRender = true;
			render();
		}
	};

	const moveSelectionByPage = (direction: "up" | "down") => {
		if (state.sessions.length === 0) {
			return;
		}

		const { columnCount, gridHeight } = getGridLayoutMetrics();
		const nextIndex = moveSelectionByPageInGrid({
			sessions: state.sessions,
			selectedIndex: state.selectedIndex < 0 ? 0 : state.selectedIndex,
			columnCount,
			visibleRowCount: getGridVisibleRowCount(gridHeight),
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

		if (renderer.getSelection()) {
			renderer.clearSelection();
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

		const selectedSession = state.sessions[state.selectedIndex] ?? null;
		if (!selectedSession) {
			return;
		}

		if (!canDeleteSession(selectedSession)) {
			showToast(
				`${getSessionSourceLabel(selectedSession.sessionSource)} delete is not available yet`,
			);
			return;
		}

		const source = selectedSession.sessionSource;
		const sessionPath = selectedSession.sourceMetadata?.sessionPath;
		if (
			(source === "pi" || source === "omp" || source === "gjc") &&
			!sessionPath
		) {
			showToast(`${getSessionSourceLabel(source)} session path is unavailable`);
			return;
		}

		state.pendingDeleteTarget = {
			id: selectedSession.id,
			title: sanitizeText(selectedSession.title, "Untitled session"),
			source,
			sessionPath,
			missionControlDatabasePath:
				selectedSession.sourceMetadata?.missionControl?.canonicalDatabasePath,
		};
		state.deleteConfirmationError = null;
		render();
	};

	const cancelDeleteConfirmation = () => {
		if (!state.pendingDeleteTarget && !state.deleteConfirmationError) {
			return;
		}

		state.pendingDeleteTarget = null;
		state.deleteConfirmationError = null;
		state.isDeletingSession = false;
		render();
	};

	const confirmDeleteSession = async () => {
		if (!state.pendingDeleteTarget || state.isDeletingSession) {
			return;
		}

		const target = state.pendingDeleteTarget;
		const sessionId = target.id;
		const requiresJsonlSessionReset =
			target.source === "pi" ||
			target.source === "omp" ||
			target.source === "gjc";
		let jsonlSessionResetComplete = false;
		state.isDeletingSession = true;
		state.deleteConfirmationError = null;
		stopPolling();
		render();
		renderer.intermediateRender();

		try {
			if (requiresJsonlSessionReset) {
				await resetWorkerForJsonlDelete();
				jsonlSessionResetComplete = true;
			}

			if (target.source === "codex") {
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
			} else if (target.source === "claude") {
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
			} else if (target.source === "pi") {
				const deleteResult = await deletePiSession(sessionId, {
					sessionPath: target.sessionPath,
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.cause
							? `${deleteResult.error.message}: ${deleteResult.error.cause}`
							: deleteResult.error.message,
						"Pi session delete failed.",
					);
					render();
					return;
				}
			} else if (target.source === "omp") {
				const deleteResult = await deleteOmpSession(sessionId, {
					sessionPath: target.sessionPath,
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.cause
							? `${deleteResult.error.message}: ${deleteResult.error.cause}`
							: deleteResult.error.message,
						"omp session delete failed.",
					);
					render();
					return;
				}
			} else if (target.source === "gjc") {
				const deleteResult = await deleteGjcSession(sessionId, {
					sessionPath: target.sessionPath,
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.cause
							? `${deleteResult.error.message}: ${deleteResult.error.cause}`
							: deleteResult.error.message,
						"gjc session delete failed.",
					);
					render();
					return;
				}
			} else if (target.source === "mission-control") {
				const deleteResult = await deleteMissionControlSession(sessionId, {
					...(target.missionControlDatabasePath
						? { databasePath: target.missionControlDatabasePath }
						: {}),
				});
				if (!deleteResult.ok) {
					state.isDeletingSession = false;
					state.deleteConfirmationError = sanitizeText(
						deleteResult.error.message,
						"Mission Control session delete failed.",
					);
					render();
					return;
				}
			} else {
				const opencodeExecutable = which("opencode") ?? "opencode";
				const child = spawn(
					opencodeExecutable,
					["session", "delete", sessionId],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdoutText = "";
				let stderrText = "";
				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => {
					stdoutText += chunk;
				});
				child.stderr?.on("data", (chunk: string) => {
					stderrText += chunk;
				});
				const exitCode = await new Promise<number>((resolve, reject) => {
					child.on("close", (code) => resolve(code ?? 1));
					child.on("error", reject);
				});

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
			state.pendingDeleteTarget = null;
			state.deleteConfirmationError = null;
			state.gridFollowSelectionOnRender = true;
			if (!requiresJsonlSessionReset) {
				refreshSessions();
			}
		} catch (error) {
			state.isDeletingSession = false;
			state.deleteConfirmationError =
				error instanceof Error
					? error.message
					: `Failed to start ${getSessionSourceLabel(target.source)} session delete.`;
			render();
		} finally {
			if (
				requiresJsonlSessionReset &&
				jsonlSessionResetComplete &&
				currentRefreshWorker?.status === "usable" &&
				!isShuttingDown
			) {
				pendingSelectionRender = false;
				refreshDispatchGateOpen = true;
				refreshSessions();
				startPolling();
			} else if (!requiresJsonlSessionReset) {
				startPolling();
			}
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
				`${getSessionSourceLabel(selectedSession.sessionSource)} session stop is not available yet`,
			);
			return;
		}

		const plan = getAbortTargets(selectedSession);

		if (plan.targets.length === 0) {
			showToast("No stuck or active sessions to stop");
			return;
		}

		state.pendingKillSessionId = selectedSession.id;
		state.pendingKillChildrenCount = plan.childCount;
		state.pendingKillIncludesSelected = plan.includesSelected;
		state.pendingKillSummary = formatAbortTargetSummary(plan);
		state.killChildrenError = null;
		state.isKillingChildren = false;
		state.killFallbackNotice = null;
		state.missionControlFallbackPlan = null;
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
		state.pendingKillIncludesSelected = false;
		state.pendingKillSummary = null;
		state.isKillingChildren = false;
		state.killChildrenError = null;
		state.killFallbackRemaining = [];
		state.killFallbackConfirmed = [];
		state.killFallbackCurrentIndex = 0;
		state.killFallbackNotice = null;
		state.missionControlFallbackPlan = null;
		render();
	};

	const gracefulAbortSession = async (
		session: Pick<
			SubagentSession,
			"id" | "sessionSource" | "directory" | "sourceMetadata"
		>,
		projectDir: string,
	): Promise<{ ok: boolean; error?: string }> => {
		if (session.sessionSource === "codex") {
			return abortCodexChildSession(session);
		}

		if (session.sessionSource === "omp" || session.sessionSource === "gjc") {
			return stopJsonlSession(session.sessionSource, {
				sessionPath: session.sourceMetadata?.sessionPath,
			});
		}

		return stopOpencodeSession({
			sessionId: session.id,
			directory: session.directory?.trim() || projectDir,
		});
	};

	const confirmKillChildren = async () => {
		if (!state.pendingKillSessionId || state.isKillingChildren) return;

		const rootSessionId = state.pendingKillSessionId;
		const selectedSession = state.allSessions.find(
			(s) => s.id === rootSessionId,
		);
		if (!selectedSession) {
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.pendingKillIncludesSelected = false;
			state.pendingKillSummary = null;
			state.isKillingChildren = false;
			state.killChildrenError = null;
			render();
			return;
		}

		const plan = getAbortTargets(selectedSession);

		if (plan.targets.length === 0) {
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.pendingKillIncludesSelected = false;
			state.pendingKillSummary = null;
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
			if (selectedSession.sessionSource === "mission-control") {
				const result = await prepareMissionControlChildAbort(selectedSession, {
					refreshAfterStop: refreshSessionsAndWait,
				});
				state.isKillingChildren = false;
				if (result.kind === "failed") {
					state.killChildrenError = result.error;
					startPolling();
					render();
					return;
				}
				if (result.kind === "fallback") {
					state.missionControlFallbackPlan = result.plan;
					state.killFallbackRemaining = result.plan.roots.map(
						(root) => root.sessionId,
					);
					state.killFallbackConfirmed = [];
					state.killFallbackCurrentIndex = 0;
					state.killFallbackNotice = result.notices.join(" ") || null;
					startPolling();
					render();
					return;
				}
				state.pendingKillSessionId = null;
				state.pendingKillChildrenCount = 0;
				state.pendingKillIncludesSelected = false;
				state.pendingKillSummary = null;
				state.killChildrenError = null;
				state.gridFollowSelectionOnRender = true;
				showToast("Stopped Mission Control child sessions");
				startPolling();
				return;
			}

			const projectDir = selectedSession.directory || process.cwd();
			const targets = plan.targets;

			const results = await Promise.allSettled(
				targets.map((target) => gracefulAbortSession(target, projectDir)),
			);
			const failedIds = targets
				.filter((_, i) => {
					const result = results[i];
					return (
						!result ||
						result.status === "rejected" ||
						(result.status === "fulfilled" && !result.value.ok)
					);
				})
				.map((target) => target.id);
			const successCount = targets.length - failedIds.length;

			if (
				(selectedSession.sessionSource === "omp" ||
					selectedSession.sessionSource === "gjc") &&
				failedIds.length > 0
			) {
				state.isKillingChildren = false;
				state.killChildrenError = `Could not stop ${getSessionSourceLabel(selectedSession.sessionSource)} session${failedIds.length === 1 ? "" : "s"}: ${failedIds.join(", ")}. Session history was not deleted.`;
				startPolling();
				render();
				return;
			}

			if (failedIds.length > 0) {
				state.isKillingChildren = false;
				state.killFallbackRemaining = failedIds;
				state.killFallbackConfirmed = [];
				state.killFallbackCurrentIndex = 0;
				if (successCount > 0) {
					showToast(
						`Stopped ${successCount}/${targets.length} sessions (${failedIds.length} need delete)`,
					);
				}
				startPolling();
				render();
				return;
			}

			state.isKillingChildren = false;
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.pendingKillIncludesSelected = false;
			state.pendingKillSummary = null;
			state.killChildrenError = null;
			state.gridFollowSelectionOnRender = true;

			showToast(
				`Stopped ${targets.length} session${targets.length === 1 ? "" : "s"}`,
			);
			startPolling();
			refreshSessions();
		} catch (error) {
			state.isKillingChildren = false;
			state.killChildrenError =
				error instanceof Error
					? error.message
					: "Failed to stop stuck/active sessions.";
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
			state.killFallbackNotice = null;
			state.missionControlFallbackPlan = null;
			state.pendingKillSessionId = null;
			state.pendingKillChildrenCount = 0;
			state.pendingKillIncludesSelected = false;
			state.pendingKillSummary = null;
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
			const missionControlPlan = state.missionControlFallbackPlan;
			const fallbackRoute = resolveKillFallbackRoute(
				missionControlPlan,
				rootSession?.sessionSource,
			);
			if (fallbackRoute === "mission-control" && missionControlPlan) {
				const result = await executeMissionControlFallback(
					missionControlPlan,
					confirmedIds,
				);
				if (!result.ok) {
					state.isKillingChildren = false;
					state.killChildrenError = result.error;
					state.killFallbackRemaining = [];
					state.killFallbackConfirmed = [];
					state.killFallbackCurrentIndex = 0;
					state.killFallbackNotice = null;
					state.missionControlFallbackPlan = null;
					startPolling();
					render();
					return;
				}
				state.isKillingChildren = false;
				state.pendingKillSessionId = null;
				state.pendingKillChildrenCount = 0;
				state.pendingKillIncludesSelected = false;
				state.pendingKillSummary = null;
				state.killChildrenError = null;
				state.killFallbackRemaining = [];
				state.killFallbackConfirmed = [];
				state.killFallbackCurrentIndex = 0;
				state.killFallbackNotice = null;
				state.missionControlFallbackPlan = null;
				state.gridFollowSelectionOnRender = true;
				showToast(
					`Deleted ${result.deletedRootIds.length} child session subtree${result.deletedRootIds.length === 1 ? "" : "s"}`,
				);
				startPolling();
				refreshSessions();
				return;
			}
			if (fallbackRoute === "stale-mission-control") {
				state.isKillingChildren = false;
				state.killChildrenError =
					"Mission Control fallback confirmation is stale.";
				state.killFallbackRemaining = [];
				state.killFallbackConfirmed = [];
				state.killFallbackCurrentIndex = 0;
				state.killFallbackNotice = null;
				startPolling();
				render();
				return;
			}
			const results = await Promise.allSettled(
				confirmedIds.map(async (childId) => {
					if (fallbackRoute === "codex") {
						const result = await deleteCodexSession(childId);
						if (!result.ok) {
							throw result.error;
						}

						return childId;
					}

					const opencodeExecutable = which("opencode") ?? "opencode";
					const child = spawn(
						opencodeExecutable,
						["session", "delete", childId],
						{ stdio: ["ignore", "pipe", "pipe"] },
					);
					const exitCode = await new Promise<number>((resolve, reject) => {
						child.on("close", (code) => resolve(code ?? 1));
						child.on("error", reject);
					});
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
			state.pendingKillIncludesSelected = false;
			state.pendingKillSummary = null;
			state.killChildrenError = null;
			state.killFallbackRemaining = [];
			state.killFallbackConfirmed = [];
			state.killFallbackCurrentIndex = 0;
			state.killFallbackNotice = null;
			state.missionControlFallbackPlan = null;
			state.gridFollowSelectionOnRender = true;

			if (failedCount > 0) {
				showToast(
					`Deleted ${successCount}/${confirmedIds.length} sessions (${failedCount} failed)`,
				);
			} else {
				showToast(
					`Deleted ${confirmedIds.length} session${confirmedIds.length === 1 ? "" : "s"}`,
				);
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
		state.pendingKillIncludesSelected = false;
		state.pendingKillSummary = null;
		state.killChildrenError = null;
		state.killFallbackRemaining = [];
		state.killFallbackConfirmed = [];
		state.killFallbackCurrentIndex = 0;
		state.killFallbackNotice = null;
		state.missionControlFallbackPlan = null;
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
			clearAlternateScreen();
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

		if (renderer.getSelection()) {
			renderer.clearSelection();
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

	const retireRefreshWorkerOnShutdown = () => {
		isShuttingDown = true;
		refreshDispatchGateOpen = false;
		const instance = currentRefreshWorker;
		if (!instance) {
			return;
		}

		instance.status = "retiring";
		rejectControlWaiter(
			instance,
			new RefreshCompletionError("Refresh worker stopped during shutdown."),
		);
		instance.worker.removeAllListeners();
		try {
			void instance.worker.terminate();
		} catch {}
	};

	const shutdown = () => {
		retireRefreshWorkerOnShutdown();

		if (isResizeDebouncing.value) {
			clearTimeout(isResizeDebouncing.value);
			isResizeDebouncing.value = null;
		}

		stopPolling();

		flushRenderStats();
		renderer.destroy();
		restorePrimaryScreen();
		process.exit(0);
	};

	renderer.on("resize", scheduleRender);
	renderer.on("selection", (selection) => {
		if (!selection) {
			clearCompletedTextSelection();
			return;
		}

		copyCompletedTextSelection();
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

		if (key.ctrl && key.name === "s") {
			state.isStatsModalVisible = !state.isStatsModalVisible;
			render();
			return;
		}

		if (state.isStatsModalVisible) {
			if (key.name === "escape" || key.name === "q") {
				state.isStatsModalVisible = false;
				render();
			}
			return;
		}

		copyCompletedTextSelection();

		if (state.pendingDeleteTarget) {
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

			if (key.name === "pageup") {
				scrollHierarchyPage("up");
				return;
			}

			if (key.name === "pagedown") {
				scrollHierarchyPage("down");
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

		if (isSessionStopShortcut(key)) {
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

			case "pageup":
				if (state.focusedPane === "detail") {
					scrollDetailPage("up");
					break;
				}

				moveSelectionByPage("up");
				break;

			case "pagedown":
				if (state.focusedPane === "detail") {
					scrollDetailPage("down");
					break;
				}

				moveSelectionByPage("down");
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

	renderer.start();
	void refreshExternalAttachedSessionSignals();
	render();
	void installAndReadyWorker();

	process.on("exit", () => {
		retireRefreshWorkerOnShutdown();

		stopPolling();
		flushRenderStats();
	});
};

void main();
