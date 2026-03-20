import { writeFileSync } from "node:fs";
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

import {
	createRequest,
	isRefreshResponse,
	type RefreshResponse,
	type RefreshSnapshotPayload,
} from "./db/refresh-worker-protocol";
import {
	createRefreshCoordinator,
	type RefreshRequestId,
} from "./lib/refreshCoordinator";
import type { SessionStatusById } from "./lib/sessionSnapshot";
import { type Session, SessionStatus } from "./types";
import { createDetailPanelContent } from "./ui/DetailPanel";
import { SESSION_CARD_MAX_HEIGHT } from "./ui/SessionCard";
import {
	createSessionGridContent,
	getGridColumnCount,
	SESSION_GRID_ROW_GAP,
	SESSION_GRID_VIEWPORT_VERTICAL_INSET,
} from "./ui/SessionGrid";

const APP_ROOT_ID = "session-monitor-root";
const FOOTER_CONTAINER_ID = "session-monitor-footer";
const STATUS_TEXT_ID = "session-monitor-status";
const CONTROL_TEXT_ID = "session-monitor-controls";
const CONTENT_CONTAINER_ID = "session-monitor-content";
const DELETE_CONFIRMATION_OVERLAY_ID = "session-monitor-delete-confirmation";
const GRID_SCROLLBOX_ID = "session-grid-scrollbox";
const GRID_CONTENT_ID = "session-grid-content";
const DETAIL_SCROLLBOX_ID = "session-detail-scrollbox";
const DETAIL_CONTENT_ID = "session-detail-content";
const POLL_INTERVAL_MS = 2000;
const RESIZE_DEBOUNCE_MS = 150;
const DETAIL_SCROLL_STEP = 3;
const SIDEVIEW_SHORTCUT_LABEL = "e/p";
const FILTER_SHORTCUT_LABEL = "f";
const ATTACH_SHORTCUT_LABEL = "a";
const COPY_ID_SHORTCUT_LABEL = "i";
const DELETE_SHORTCUT_LABEL = "d";
const SORT_SHORTCUT_LABEL = "s";
const ROOT_PADDING_TOP = 1;
const ROOT_PADDING_X = 2;
const ROOT_CONTENT_GAP = 1;
const FOOTER_INLINE_GAP = 1;
const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";

type FocusPane = "grid" | "detail";
type SessionFilterMode = "latest" | "active" | "all";
type SessionSortMode = "status" | "update" | "create";

const SESSION_FILTER_CYCLE: SessionFilterMode[] = ["latest", "active", "all"];
const SESSION_SORT_CYCLE: SessionSortMode[] = ["status", "update", "create"];

interface SessionFilterResult {
	sessions: Session[];
	hiddenCompletedCount: number;
}

interface SelectionSnapshot {
	selectedRenderables: Renderable[];
	getSelectedText(): string;
}

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

const normalizeDirectoryKey = (directory: string): string =>
	directory
		.trim()
		.replace(/[\\/]+$/gu, "")
		.toLowerCase();

const isActiveSessionStatus = (status?: SessionStatus): boolean =>
	status === SessionStatus.pending ||
	status === SessionStatus.running ||
	status === SessionStatus.waiting;

const getSessionStatusSortRank = (status?: SessionStatus): number => {
	if (status === SessionStatus.waiting) {
		return 0;
	}

	if (status === SessionStatus.running) {
		return 1;
	}

	if (status === SessionStatus.completed) {
		return 3;
	}

	return 2;
};

const applySessionFilter = (
	sessions: Session[],
	filterMode: SessionFilterMode,
): SessionFilterResult => {
	switch (filterMode) {
		case "all":
			return { sessions, hiddenCompletedCount: 0 };

		case "active":
			return {
				sessions: sessions.filter((session) =>
					isActiveSessionStatus(session.status),
				),
				hiddenCompletedCount: 0,
			};

		case "latest": {
			const latestCompletedByDirectory = new Set<string>();
			const orderedSessions = [...sessions].sort(
				(left, right) => right.time_updated - left.time_updated,
			);
			let hiddenCompletedCount = 0;

			const filteredSessions = orderedSessions.filter((session) => {
				if (session.status !== SessionStatus.completed) {
					return true;
				}

				const directoryKey = normalizeDirectoryKey(session.directory);
				if (!latestCompletedByDirectory.has(directoryKey)) {
					latestCompletedByDirectory.add(directoryKey);
					return true;
				}

				hiddenCompletedCount += 1;
				return false;
			});

			return {
				sessions: filteredSessions,
				hiddenCompletedCount,
			};
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

const applySessionSort = (
	sessions: Session[],
	sortMode: SessionSortMode,
): Session[] => {
	const orderedSessions = [...sessions];

	orderedSessions.sort((left, right) => {
		switch (sortMode) {
			case "create": {
				if (left.time_created !== right.time_created) {
					return right.time_created - left.time_created;
				}
				break;
			}

			case "update": {
				if (left.time_updated !== right.time_updated) {
					return right.time_updated - left.time_updated;
				}
				break;
			}

			case "status": {
				const leftRank = getSessionStatusSortRank(left.status);
				const rightRank = getSessionStatusSortRank(right.status);

				if (leftRank !== rightRank) {
					return leftRank - rightRank;
				}

				if (left.time_updated !== right.time_updated) {
					return right.time_updated - left.time_updated;
				}
				break;
			}
		}

		if (left.time_updated !== right.time_updated) {
			return right.time_updated - left.time_updated;
		}

		if (left.time_created !== right.time_created) {
			return right.time_created - left.time_created;
		}

		return left.id.localeCompare(right.id);
	});

	return orderedSessions;
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

const formatFilterBadge = (
	mode: SessionFilterMode,
	activeMode: SessionFilterMode,
): string => (mode === activeMode ? `[${mode.toUpperCase()}]` : mode);

const createBannerText = (state: AppState): string => {
	if (state.dbError) {
		return `error: ${state.dbError}`;
	}

	if (state.sessions.length === 0) {
		return `sessions: 0 | filter: ${state.sessionFilterMode}`;
	}

	const parseIssueCount = Object.keys(state.sessionIssues).length;
	if (parseIssueCount > 0) {
		return `sessions: ${state.sessions.length} (${parseIssueCount} data issue${parseIssueCount === 1 ? "" : "s"} detected)`;
	}

	return `sessions: ${state.sessions.length}`;
};

interface AppState {
	sessions: Session[];
	selectedIndex: number;
	selectedSessionId: string | null;
	pendingDeleteSessionId: string | null;
	pendingDeleteSessionTitle: string | null;
	deleteConfirmationError: string | null;
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
	sessionFilterMode: SessionFilterMode;
	sessionSortMode: SessionSortMode;
	hiddenCompletedCount: number;
	isAttachingSession: boolean;
	isDeletingSession: boolean;
	dbError: string | null;
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

const isDescendantRenderable = (
	renderable: Renderable,
	ancestor: Renderable,
): boolean => {
	let current: Renderable | null = renderable;

	while (current) {
		if (current === ancestor) {
			return true;
		}

		current = current.parent;
	}

	return false;
};

const clearTerminalScreen = () => {
	try {
		process.stdout.write(CLEAR_TERMINAL_SEQUENCE);
	} catch {}
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
}) => {
	const heading = params.isDeleting ? "Deleting session" : "Delete session";
	const body = params.isDeleting
		? "Deleting the selected OpenCode session. Please wait."
		: "Delete the selected OpenCode session? This cannot be undone.";
	const hint = params.isDeleting
		? "The session list will refresh automatically when the command finishes."
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

const pruneDetailScrollState = (
	detailScrollTopBySessionId: Partial<Record<string, number>>,
	sessions: Session[],
): Partial<Record<string, number>> => {
	const activeSessionIds = new Set(sessions.map((session) => session.id));

	return Object.fromEntries(
		Object.entries(detailScrollTopBySessionId).filter(([sessionId]) =>
			activeSessionIds.has(sessionId),
		),
	);
};

const getGridVisibleRowCount = (gridHeight: number): number => {
	const viewportHeight = Math.max(
		gridHeight - SESSION_GRID_VIEWPORT_VERTICAL_INSET,
		1,
	);
	const rowStride = SESSION_CARD_MAX_HEIGHT + SESSION_GRID_ROW_GAP;

	return Math.max(
		1,
		Math.floor((viewportHeight + SESSION_GRID_ROW_GAP) / rowStride),
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
		sessions: [],
		selectedIndex: -1,
		selectedSessionId: null,
		pendingDeleteSessionId: null,
		pendingDeleteSessionTitle: null,
		deleteConfirmationError: null,
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
		sessionFilterMode: "latest",
		sessionSortMode: "status",
		hiddenCompletedCount: 0,
		isAttachingSession: false,
		isDeletingSession: false,
		dbError: null,
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
	let isRefreshApplying = false;

	const renderStatsPath = process.env.GCTRL_RENDER_STATS || "";
	const renderStats = renderStatsPath
		? {
				applyTriggeredRenders: 0,
				liveFrameRenders: 0,
				liveFrameSkippedDuringApply: 0,
			}
		: null;

	const getStateForSession = (
		sessionId?: string,
	): { summary?: string; status?: SessionStatus } => {
		if (!sessionId) {
			return {};
		}

		return {
			summary: sanitizeText(state.sessionIssues[sessionId], ""),
			status: state.statusBySessionId[sessionId],
		};
	};

	const syncWaitingPulseRendering = () => {
		const shouldPulse =
			!state.isAttachingSession &&
			state.sessions.some(
				(session) => session.status === SessionStatus.waiting,
			);

		if (shouldPulse && !isWaitingPulseLive) {
			renderer.requestLive();
			isWaitingPulseLive = true;
			return;
		}

		if (!shouldPulse && isWaitingPulseLive) {
			renderer.dropLive();
			isWaitingPulseLive = false;
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
	};

	const render = () => {
		const existingRoot = renderer.root.findDescendantById(APP_ROOT_ID);
		const existingGridScrollBox =
			renderer.root.findDescendantById(GRID_SCROLLBOX_ID);
		const existingDetailScrollBox =
			renderer.root.findDescendantById(DETAIL_SCROLLBOX_ID);
		const footerContainer =
			renderer.root.findDescendantById(FOOTER_CONTAINER_ID);
		const statusText = renderer.root.findDescendantById(STATUS_TEXT_ID);
		const controlText = renderer.root.findDescendantById(CONTROL_TEXT_ID);
		const contentContainer =
			renderer.root.findDescendantById(CONTENT_CONTAINER_ID);
		const gridContent = renderer.root.findDescendantById(GRID_CONTENT_ID);
		const detailContent = renderer.root.findDescendantById(DETAIL_CONTENT_ID);
		const deleteConfirmationOverlay = renderer.root.findDescendantById(
			DELETE_CONFIRMATION_OVERLAY_ID,
		);
		const activeDetailSessionId = state.renderedDetailSessionId;

		if (
			!isBoxRenderable(existingRoot) ||
			!isScrollBoxRenderable(existingGridScrollBox) ||
			!isScrollBoxRenderable(existingDetailScrollBox) ||
			!isBoxRenderable(footerContainer) ||
			!isTextRenderable(statusText) ||
			!isTextRenderable(controlText) ||
			!isBoxRenderable(contentContainer) ||
			!isBoxRenderable(gridContent) ||
			!isBoxRenderable(detailContent) ||
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

		const width = getSafeNumber(renderer.width, 80);
		const height = getSafeNumber(renderer.height, 24);
		const innerWidth = Math.max(width - ROOT_PADDING_X, 1);

		const headerText = createBannerText(state);
		const detailWidth = Math.max(Math.floor(innerWidth * 0.34), 22);
		const gridWidth = getGridWidth(innerWidth, state.isSideviewMode);
		const detailOnlyMode = state.isDetailMode && !state.isSideviewMode;
		const showGrid = !detailOnlyMode;
		const showDetail = state.isSideviewMode || detailOnlyMode;
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
		const deletePromptActive = Boolean(state.pendingDeleteSessionId);
		state.focusedPane = getFocusedPane(showGrid, showDetail, state.focusedPane);
		const focusLabel = state.focusedPane === "detail" ? "detail" : "grid";
		const focusSummary = canSwitchFocus
			? `${headerText} | sort: ${state.sessionSortMode} | focus: ${focusLabel}`
			: headerText;
		const shortcutPrefix = canSwitchFocus ? "Tab: switch pane | " : "";
		const filterBadgeText = SESSION_FILTER_CYCLE.map((mode) =>
			formatFilterBadge(mode, state.sessionFilterMode),
		).join(" ");
		const hiddenCompletedSummary =
			state.sessionFilterMode === "latest" && state.hiddenCompletedCount > 0
				? ` | hidden completed: ${state.hiddenCompletedCount}`
				: "";
		const shortcutGuide = deletePromptActive
			? state.isDeletingSession
				? "Deleting selected session..."
				: "Delete selected session? y: confirm | Esc/n: cancel"
			: state.focusedPane === "detail"
				? `Filters: ${filterBadgeText} | ${FILTER_SHORTCUT_LABEL}/click: cycle | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}↑/↓/j/k: scroll detail | ${ATTACH_SHORTCUT_LABEL}: attach | ${COPY_ID_SHORTCUT_LABEL}: copy id | ${DELETE_SHORTCUT_LABEL}: delete | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | q/Esc: quit`
				: `Filters: ${filterBadgeText} | ${FILTER_SHORTCUT_LABEL}/click: cycle | ${SORT_SHORTCUT_LABEL}: sort(${state.sessionSortMode}) | ${shortcutPrefix}arrows/j/k: move grid | Enter: detail | ${ATTACH_SHORTCUT_LABEL}: attach | ${COPY_ID_SHORTCUT_LABEL}: copy id | ${DELETE_SHORTCUT_LABEL}: delete | ${SIDEVIEW_SHORTCUT_LABEL}: sideview | q/Esc: quit`;
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

		const selectedSession = state.sessions[state.selectedIndex] ?? null;
		const nextDetailScrollTop = selectedSession?.id
			? (state.detailScrollTopBySessionId[selectedSession.id] ?? 0)
			: 0;
		const selectedState = getStateForSession(selectedSession?.id);
		const shouldRestoreDetailScroll =
			showDetail && selectedSession?.id !== state.renderedDetailSessionId;

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
			(deletePromptActive
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
			: t`${dim(rightFooterText.padStart(rightFooterWidth))}`;
		statusText.truncate = true;

		controlText.width = footerWraps ? footerAvailableWidth : leftFooterWidth;
		controlText.content = t`${dim(shortcutGuide)}`;
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

		replaceChildren(gridContent, [
			createSessionGridContent({
				sessions: state.sessions,
				selectedIndex: state.selectedIndex,
				isFocusedPane: state.focusedPane === "grid",
				statusBySessionId: state.statusBySessionId,
				onSelectSession: selectSessionById,
				width: showGrid ? gridLayoutWidth : innerWidth,
			}),
		]);

		replaceChildren(detailContent, [
			createDetailPanelContent({
				session: selectedSession,
				messageCount: selectedSession?.id
					? state.messageCountBySessionId[selectedSession.id]
					: undefined,
				agents: selectedSession
					? [
							...(selectedSession.currentAgent
								? [selectedSession.currentAgent]
								: []),
							...(selectedSession.subagentSessions ?? []).flatMap((subagent) =>
								subagent.currentAgent ? [subagent.currentAgent] : [],
							),
						]
					: [],
				status: selectedState.status,
				summary: selectedState.summary,
				width: showDetail
					? detailOnlyMode
						? innerWidth
						: detailWidth
					: innerWidth,
			}),
		]);

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
						}),
					]
				: [],
		);

		if (showGrid && state.gridFollowSelectionOnRender) {
			existingGridScrollBox.scrollTo({ x: 0, y: state.gridScrollTop });
		}

		if (showDetail && shouldRestoreDetailScroll) {
			existingDetailScrollBox.scrollTo({ x: 0, y: nextDetailScrollTop });
		}

		state.detailScrollTop = showDetail
			? shouldRestoreDetailScroll
				? nextDetailScrollTop
				: existingDetailScrollBox.scrollTop
			: 0;
		state.renderedDetailSessionId = showDetail
			? (selectedSession?.id ?? null)
			: null;
		syncWaitingPulseRendering();
		state.gridFollowSelectionOnRender = false;
	};

	const applyRefreshErrorState = (errorMessage: string) => {
		state.sessions = [];
		state.statusBySessionId = {};
		state.gridScrollTop = 0;
		state.gridFollowSelectionOnRender = false;
		state.detailScrollTop = 0;
		state.detailScrollTopBySessionId = {};
		state.messageCountBySessionId = {};
		state.sessionIssues = {};
		state.hiddenCompletedCount = 0;
		state.selectedIndex = -1;
		state.selectedSessionId = null;
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
		state.detailScrollTopBySessionId = pruneDetailScrollState(
			state.detailScrollTopBySessionId,
			snapshot.sessions,
		);

		const filterResult = applySessionFilter(
			snapshot.sessions,
			state.sessionFilterMode,
		);
		state.sessions = applySessionSort(
			filterResult.sessions,
			state.sessionSortMode,
		);
		state.hiddenCompletedCount = filterResult.hiddenCompletedCount;
		state.statusBySessionId = snapshot.statusBySessionId;
		state.messageCountBySessionId = snapshot.messageCountBySessionId;
		state.sessionIssues = snapshot.sessionIssues;
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

	const handleRefreshResponse = (response: RefreshResponse) => {
		try {
			if (!refreshCoordinator.shouldApplyResponse(response.requestId)) {
				return;
			}

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
		} finally {
			completeRefreshRequest(response.requestId);
		}
	};

	const failActiveRefreshRequest = (errorMessage: string) => {
		const activeRequestId = refreshCoordinator.getSnapshot().activeRequestId;
		if (activeRequestId === null) {
			state.dbError = errorMessage;
			render();
			return;
		}

		try {
			if (refreshCoordinator.shouldApplyResponse(activeRequestId)) {
				isRefreshApplying = true;
				if (renderStats) renderStats.applyTriggeredRenders++;
				try {
					applyRefreshErrorState(errorMessage);
				} finally {
					isRefreshApplying = false;
				}
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

	const copySelectedSessionId = () => {
		if (!state.selectedSessionId) {
			return;
		}

		renderer.copyToClipboardOSC52(state.selectedSessionId);
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
		const opencodeExecutable = Bun.which("opencode") ?? "opencode";
		state.isDeletingSession = true;
		state.deleteConfirmationError = null;
		stopPolling();
		render();
		renderer.intermediateRender();

		try {
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
					: "Failed to start opencode session delete.";
			render();
		} finally {
			startPolling();
		}
	};

	const attachToSelectedSession = async () => {
		if (state.isAttachingSession || !state.selectedSessionId) {
			return;
		}

		const selectedSession = state.sessions.find(
			(session) => session.id === state.selectedSessionId,
		);
		if (!selectedSession) {
			return;
		}

		const opencodeExecutable = Bun.which("opencode") ?? "opencode";
		state.isAttachingSession = true;
		render();
		renderer.intermediateRender();

		if (interval) {
			clearInterval(interval);
			interval = null;
		}

		try {
			renderer.suspend();
			clearTerminalScreen();

			const child = Bun.spawn({
				cmd: [opencodeExecutable, "--session", selectedSession.id],
				cwd: sanitizeText(selectedSession.directory, process.cwd()),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});

			await child.exited;
		} finally {
			state.isAttachingSession = false;
			clearTerminalScreen();
			renderer.resume();
			refreshSessions();
			startPolling();
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

		flushRenderStats();
		renderer.destroy();
		process.exit(0);
	};

	renderer.on("resize", scheduleRender);
	renderer.on("selection", (selection: SelectionSnapshot | null) => {
		const detailContent = renderer.root.findDescendantById(DETAIL_CONTENT_ID);
		if (!isBoxRenderable(detailContent)) {
			return;
		}

		if (
			!selection ||
			!Array.isArray(selection.selectedRenderables) ||
			selection.selectedRenderables.length === 0
		) {
			return;
		}

		const isDetailSelection = selection.selectedRenderables.some(
			(renderable) =>
				isRenderable(renderable) &&
				isDescendantRenderable(renderable, detailContent),
		);
		if (!isDetailSelection) {
			return;
		}

		const selectedText =
			typeof selection.getSelectedText === "function"
				? selection.getSelectedText().trim()
				: "";
		if (!selectedText) {
			return;
		}

		renderer.copyToClipboardOSC52(selectedText);
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

		if (renderStats) renderStats.liveFrameRenders++;
		render();
	});

	await renderer.start();
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
