import {
	Box,
	createCliRenderer,
	dim,
	fg,
	type KeyEvent,
	Text,
	t,
} from "@opentui/core";

import {
	detectSessionStatus,
	getActiveSessions,
	getLatestMessages,
	getMessageCounts,
	type LatestMessageResultsBySessionId,
	type MessageCountsBySessionId,
} from "./db";
import { type Session, SessionStatus } from "./types";
import { DetailPanel } from "./ui/DetailPanel";
import { SessionGrid } from "./ui/SessionGrid";

const APP_ROOT_ID = "session-monitor-root";
const POLL_INTERVAL_MS = 2000;
const RESIZE_DEBOUNCE_MS = 150;

type SessionStatusById = Partial<Record<string, SessionStatus>>;

interface SessionSnapshot {
	sessions: Session[];
	statusBySessionId: SessionStatusById;
	messageCountBySessionId: Partial<Record<string, number>>;
	sessionIssues: Partial<Record<string, string>>;
}

const APP_PALETTE = {
	bg: "#020617",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
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

const buildSessionSnapshot = (params: {
	rawSessions: Session[];
	latestMessages: LatestMessageResultsBySessionId;
	messageCounts: MessageCountsBySessionId;
}): SessionSnapshot => {
	const nextSessionsById = new Map<string, Session>();
	const nextStatusBySessionId: SessionStatusById = {};
	const nextMessageCountBySessionId: Partial<Record<string, number>> = {};
	const nextSessionIssues: Partial<Record<string, string>> = {};
	const orderedSessions: Session[] = [];

	for (const rawSession of params.rawSessions) {
		const session: Session = {
			...rawSession,
			subagentSessions: [],
		};

		const latestMessageResult = params.latestMessages[session.id];
		const messageCount = params.messageCounts[session.id];

		if (typeof messageCount === "number") {
			nextMessageCountBySessionId[session.id] = messageCount;
		}

		if (latestMessageResult) {
			const parseResult = latestMessageResult.message;
			const status = detectSessionStatus(parseResult);
			session.status = status;
			nextStatusBySessionId[session.id] = status;

			if (parseResult.ok && parseResult.value.agent) {
				session.currentAgent = parseResult.value.agent;
			}

			if (!parseResult.ok) {
				nextSessionIssues[session.id] =
					`Data error: ${parseResult.error.message}`;
			}
		} else {
			session.status = SessionStatus.unknown;
			nextStatusBySessionId[session.id] = SessionStatus.unknown;
		}

		nextSessionsById.set(session.id, session);
		orderedSessions.push(session);
	}

	const rootSessions: Session[] = [];

	for (const session of orderedSessions) {
		if (session.parent_id) {
			const parentSession = nextSessionsById.get(session.parent_id);
			if (parentSession) {
				parentSession.subagentSessions = [
					...(parentSession.subagentSessions ?? []),
					session,
				];
				continue;
			}

			nextSessionIssues[session.id] = "Parent session not found for subagent.";
		}

		rootSessions.push(session);
	}

	return {
		sessions: rootSessions,
		statusBySessionId: nextStatusBySessionId,
		messageCountBySessionId: nextMessageCountBySessionId,
		sessionIssues: nextSessionIssues,
	};
};

const createBannerText = (state: AppState): string => {
	if (state.dbError) {
		return `error: ${state.dbError}`;
	}

	if (state.sessions.length === 0) {
		return "no active sessions";
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
	isDetailMode: boolean;
	isSideviewMode: boolean;
	statusBySessionId: SessionStatusById;
	messageCountBySessionId: Partial<Record<string, number>>;
	sessionIssues: Partial<Record<string, string>>;
	dbError: string | null;
}

const main = async () => {
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
	});

	const state: AppState = {
		sessions: [],
		selectedIndex: -1,
		isDetailMode: false,
		isSideviewMode: false,
		statusBySessionId: {},
		messageCountBySessionId: {},
		sessionIssues: {},
		dbError: null,
	};

	const isRefreshing: { value: boolean } = { value: false };
	const hasQueuedRefresh: { value: boolean } = { value: false };
	const isResizeDebouncing: { value: ReturnType<typeof setTimeout> | null } = {
		value: null,
	};

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

	const render = () => {
		const rootChildren = renderer.root.getChildren();
		const existingRoot = rootChildren.find((child) => child.id === APP_ROOT_ID);

		if (existingRoot) {
			renderer.root.remove(APP_ROOT_ID);
		}

		const width = getSafeNumber(renderer.width, 80);
		const height = getSafeNumber(renderer.height, 24);

		const headerText = createBannerText(state);
		const detailWidth = Math.max(Math.floor(width * 0.34), 22);
		const gridWidth = state.isSideviewMode
			? Math.max(width - detailWidth - 1, 1)
			: width;
		const headerHeight = 2;
		const contentHeight = Math.max(height - headerHeight - 2, 1);

		const selectedSession = state.sessions[state.selectedIndex] ?? null;
		const selectedState = getStateForSession(selectedSession?.id);

		const statusLine = Text({
			content: t`${dim(headerText)}`,
			fg: APP_PALETTE.muted,
			width,
		});

		const controlLine = Text({
			content: t`${dim("q/Esc: quit | s: sideview | j/k/up/down: navigate | Enter: detail")}`,
			fg: APP_PALETTE.muted,
			width,
		});

		const titleLine = Text({
			content: t`${fg(APP_PALETTE.accent)(sanitizeText(state.dbError, "session monitor"))}`,
			fg: APP_PALETTE.text,
			width,
		});

		const detailPanel = DetailPanel({
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
			width: state.isSideviewMode ? detailWidth : "100%",
			height: contentHeight,
		});

		const grid = SessionGrid({
			sessions: state.sessions,
			selectedIndex: state.selectedIndex,
			statusBySessionId: state.statusBySessionId,
			width: gridWidth,
			height: contentHeight,
		});

		const mainContent =
			state.isDetailMode && !state.isSideviewMode
				? Box(
						{
							id: APP_ROOT_ID,
							width,
							height,
							flexDirection: "column",
							padding: 1,
							backgroundColor: APP_PALETTE.bg,
						},
						Box({ width }, titleLine, Box({ height: 1 }), detailPanel),
						Box({ height: 1 }),
						statusLine,
						controlLine,
					)
				: state.isSideviewMode
					? Box(
							{
								id: APP_ROOT_ID,
								width,
								height,
								flexDirection: "column",
								padding: 1,
								backgroundColor: APP_PALETTE.bg,
							},
							titleLine,
							Box(
								{
									width,
									height: contentHeight + 1,
									flexDirection: "row",
									gap: 1,
								},
								grid,
								detailPanel,
							),
							Box({ height: 1 }),
							statusLine,
							controlLine,
						)
					: Box(
							{
								id: APP_ROOT_ID,
								width,
								height,
								flexDirection: "column",
								padding: 1,
								backgroundColor: APP_PALETTE.bg,
							},
							titleLine,
							Box({ width, height: contentHeight + 1 }, grid),
							Box({ height: 1 }),
							state.dbError
								? Text({
										content: t`${fg(APP_PALETTE.warning)(state.dbError)}`,
										width,
									})
								: statusLine,
							controlLine,
						);

		renderer.root.add(mainContent);
	};

	const refreshSessions = () => {
		if (isRefreshing.value) {
			hasQueuedRefresh.value = true;
			return;
		}

		isRefreshing.value = true;

		try {
			const activeSessionsResult = getActiveSessions();
			if (!activeSessionsResult.ok) {
				state.sessions = [];
				state.statusBySessionId = {};
				state.messageCountBySessionId = {};
				state.sessionIssues = {};
				state.selectedIndex = -1;
				state.dbError = activeSessionsResult.error.message;

				if (state.isDetailMode && state.sessions.length === 0) {
					state.isDetailMode = false;
				}

				render();
				return;
			}

			state.dbError = null;

			const sessionIds = activeSessionsResult.value.map(
				(session) => session.id,
			);
			const latestMessagesResult = getLatestMessages(sessionIds);
			const messageCountsResult = getMessageCounts(sessionIds);

			if (!latestMessagesResult.ok || !messageCountsResult.ok) {
				state.sessions = [];
				state.statusBySessionId = {};
				state.messageCountBySessionId = {};
				state.sessionIssues = {};
				state.selectedIndex = -1;
				state.dbError = !latestMessagesResult.ok
					? latestMessagesResult.error.message
					: !messageCountsResult.ok
						? messageCountsResult.error.message
						: "Unknown database failure";

				if (state.isDetailMode && state.sessions.length === 0) {
					state.isDetailMode = false;
				}

				render();
				return;
			}

			const nextSnapshot = buildSessionSnapshot({
				rawSessions: activeSessionsResult.value,
				latestMessages: latestMessagesResult.value,
				messageCounts: messageCountsResult.value,
			});

			state.sessions = nextSnapshot.sessions;
			state.statusBySessionId = nextSnapshot.statusBySessionId;
			state.messageCountBySessionId = nextSnapshot.messageCountBySessionId;
			state.sessionIssues = nextSnapshot.sessionIssues;
			state.selectedIndex = clampSelection(state.sessions, state.selectedIndex);

			if (state.sessions.length === 0 && state.isDetailMode) {
				state.isDetailMode = false;
			}

			render();
		} finally {
			isRefreshing.value = false;

			if (hasQueuedRefresh.value) {
				hasQueuedRefresh.value = false;
				refreshSessions();
			}
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

	const moveSelection = (delta: number) => {
		if (state.sessions.length === 0) {
			return;
		}

		const nextIndex = clampSelection(
			state.sessions,
			state.selectedIndex < 0
				? delta > 0
					? 0
					: state.sessions.length - 1
				: state.selectedIndex + delta,
		);

		if (nextIndex !== state.selectedIndex) {
			state.selectedIndex = nextIndex;
			render();
		}
	};

	const shutdown = () => {
		renderer.destroy();
		process.exit(0);
	};

	renderer.on("resize", scheduleRender);

	(
		renderer.keyInput as unknown as {
			on(event: "keypress", handler: (key: KeyEvent) => void): void;
		}
	).on("keypress", (key) => {
		if (key.ctrl && key.name === "c") {
			shutdown();
			return;
		}

		switch (key.name) {
			case "j":
			case "down":
				moveSelection(1);
				break;

			case "k":
			case "up":
				moveSelection(-1);
				break;

			case "return":
			case "enter":
				if (state.sessions.length > 0) {
					state.isDetailMode = true;
					render();
				}
				break;

			case "escape":
			case "q":
				if (state.isDetailMode) {
					state.isDetailMode = false;
					render();
					break;
				}

				shutdown();
				break;

			case "s":
				state.isSideviewMode = !state.isSideviewMode;
				if (!state.isSideviewMode) {
					state.isDetailMode = false;
				}

				render();
				break;

			default:
				break;
		}
	});

	await renderer.start();
	refreshSessions();
	const interval = setInterval(() => {
		refreshSessions();
	}, POLL_INTERVAL_MS);

	render();

	process.on("exit", () => {
		clearInterval(interval);
	});
};

void main();
