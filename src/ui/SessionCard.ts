import { getAgentColor, getAgentDisplayName } from "../config/colors";
import { type Session, SessionStatus } from "../types";

const CARD_WIDTH = 38;
const MIN_CARD_WIDTH = 30;
const CONTENT_PADDING = 2;
const CONTENT_WIDTH_OFFSET = 2;
export const SESSION_CARD_MAX_HEIGHT = 15;

const CARD_COLORS = {
	selected: "*",
	normal: " ",
	danger: "!",
	recent: "#",
	waiting: "^",
} as const;

const WAITING_PULSE_INTERVAL_MS = 2200;
const RECENT_COMPLETION_WINDOW_MS = 5 * 60 * 1000;

const STATUS_LABELS: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "pending",
	[SessionStatus.running]: "running",
	[SessionStatus.waiting]: "awaiting user",
	[SessionStatus.completed]: "completed",
	[SessionStatus.failed]: "failed",
	[SessionStatus.unknown]: "unknown",
};

const clampWidth = (width?: number): number => {
	if (typeof width !== "number" || !Number.isFinite(width)) {
		return CARD_WIDTH;
	}

	return Math.max(MIN_CARD_WIDTH, Math.floor(width));
};

const truncateText = (value: string, maxLength: number): string => {
	if (maxLength <= 0) {
		return "";
	}

	if (value.length <= maxLength) {
		return value;
	}

	if (maxLength <= 3) {
		return value.slice(0, maxLength);
	}

	return `${value.slice(0, maxLength - 3)}...`;
};

const shortenMiddle = (value: string, maxLength: number): string => {
	if (maxLength <= 8 || value.length <= maxLength) {
		return truncateText(value, maxLength);
	}

	const visible = maxLength - 3;
	const left = Math.ceil(visible * 0.6);
	const right = Math.max(visible - left, 2);

	return `${value.slice(0, left)}...${value.slice(-right)}`;
};

const shortenDirectoryPath = (value: string, maxLength: number): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		return "--";
	}

	if (trimmed.length <= maxLength) {
		return trimmed;
	}

	const segments = trimmed.split(/[\\/]+/u).filter(Boolean);
	if (segments.length < 2) {
		return truncateText(trimmed, maxLength);
	}

	const suffix = `.../${segments.slice(-2).join("/")}`;
	if (suffix.length <= maxLength) {
		return suffix;
	}

	return `.../${truncateText(segments.slice(-2).join("/"), Math.max(maxLength - 4, 1))}`;
};

const normalizeTimestamp = (value: number): number | null => {
	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const padField = (label: string, value: string, width: number): string => {
	const line = `${label}: ${value}`;
	return truncateText(line, width).padEnd(width, " ");
};

const buildLine = (label: string, value: string, width: number): string => {
	return `| ${padField(label, value, width - CONTENT_PADDING)} |`;
};

const buildHeader = (text: string, width: number): string => {
	const contentWidth = Math.max(width - 2, 0);
	return `+${"-".repeat(contentWidth)}+`;
};

const normalizeAgentLabel = (value: string): string => {
	return truncateText(value.trim(), 20);
};

const normalizeSessionTitle = (value: string): string => {
	return truncateText(value.trim() || "Untitled session", 30);
};

const buildAgentLine = (session: Session, width: number): string => {
	const agent = normalizeAgentLabel(getAgentDisplayName(session.currentAgent));
	return buildLine("agent", agent, width);
};

const buildSubagentSummary = (session: Session, width: number): string => {
	const subagents = session.subagentSessions ?? [];
	if (subagents.length === 0) {
		return buildLine("subagents", "none", width);
	}

	const labels = subagents.map((subagent) => {
		const agent = getAgentDisplayName(subagent.currentAgent);
		return agent && agent.length > 0 ? agent : subagent.title.trim() || "unknown";
	});

	return buildLine("nested", truncateText(labels.join(", "), Math.max(width - 14, 1)), width);
};

const formatStatus = (status: SessionStatus): string =>
	status === SessionStatus.waiting ? "awaiting user" : STATUS_LABELS[status];

const getRunningSubagentCount = (session: Session): number => {
	return (session.subagentSessions ?? []).filter(
		(subagent) => subagent.status === SessionStatus.running,
	).length;
};

const statusToMarker = (params: {
	status?: SessionStatus;
	isWaiting?: boolean;
	isSelected: boolean;
	isRecentlyCompleted: boolean;
	waitingPulse: number;
}): string => {
	if (params.isSelected) {
		return CARD_COLORS.selected;
	}

	if (params.isWaiting) {
		return params.waitingPulse >= 0.5 ? CARD_COLORS.waiting : CARD_COLORS.normal;
	}

	if (params.isRecentlyCompleted) {
		return CARD_COLORS.recent;
	}

	return CARD_COLORS.normal;
};

const normalizeTimestampLabel = (value: number): string => {
	const normalized = normalizeTimestamp(value);
	if (normalized === null) {
		return "--";
	}

	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) {
		return "--";
	}

	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
		date.getDate(),
	).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
		date.getMinutes(),
	).padStart(2, "0")}`;
};

export interface SessionCardProps {
	session: Session;
	status?: SessionStatus;
	isSelected?: boolean;
	isActivePane?: boolean;
	isWaiting?: boolean;
	width?: number;
}

export interface SessionCardRenderResult {
	width: number;
	lines: string[];
}

export interface SessionCardRenderOptions {
	session: Session;
	status?: SessionStatus;
	isSelected?: boolean;
	isActivePane?: boolean;
	isWaiting?: boolean;
	width?: number;
}

const normalizeCardStatus = (session: Session, props: SessionCardRenderOptions) => {
	const baseStatus =
		props.status ??
		session.status ??
		(props.isWaiting ? SessionStatus.waiting : SessionStatus.unknown);

	const isWaiting = props.isWaiting ?? baseStatus === SessionStatus.waiting;
	const resolvedStatus = isWaiting ? SessionStatus.waiting : baseStatus;
	const updatedAt = normalizeTimestamp(session.time_updated);
	const recentlyCompleted =
		resolvedStatus === SessionStatus.completed &&
		updatedAt !== null &&
		Date.now() - updatedAt <= RECENT_COMPLETION_WINDOW_MS;

	return {
		resolvedStatus,
		isWaiting,
		recentlyCompleted,
		updatedAt,
	};
};

const buildCardLines = (params: {
	width: number;
	session: Session;
	status: SessionStatus;
	isSelected: boolean;
	isWaiting: boolean;
	isRecentlyCompleted: boolean;
	waitingPulse: number;
}): string[] => {
	const cardWidth = params.width;
	const contentWidth = Math.max(params.width - CONTENT_WIDTH_OFFSET, 1);
	const marker = statusToMarker({
		status: params.status,
		isWaiting: params.isWaiting,
		isSelected: params.isSelected,
		isRecentlyCompleted: params.isRecentlyCompleted,
		waitingPulse: params.waitingPulse,
	});

	const title = normalizeSessionTitle(params.session.title);
	const shortId = shortenMiddle(params.session.id || "unknown-session", 22);
	const agentColorHint = getAgentColor(params.session.currentAgent);
	const projectLabel =
		params.session.project_label || params.session.project_id || "unknown-project";
	const directory = shortenDirectoryPath(
		params.session.directory,
		Math.max(contentWidth - 14, 8),
	);

	const runningSubagentCount = getRunningSubagentCount(params.session);
	const subagentCount = params.session.subagentSessions?.length ?? 0;
	const statusLine = `${formatStatus(params.status)} (${params.status})`;
	const subagentSummary = `${runningSubagentCount} / ${subagentCount}`;

	const rows: string[] = [
		params.isWaiting
			? buildLine("watch", "[awaiting user]".padStart(15, marker), cardWidth)
			: `| ${" ".repeat(contentWidth - 1)} |`,
		params.isRecentlyCompleted
			? buildLine("state", "[recently completed]", cardWidth)
			: `| ${" ".repeat(contentWidth - 1)} |`,
		buildLine(`${marker} ${title}`, ``, cardWidth),
		buildLine("id", shortId, cardWidth),
		buildLine("status", statusLine, cardWidth),
		buildLine("project", projectLabel, cardWidth),
		buildLine("dir", directory, cardWidth),
		buildAgentLine(params.session, cardWidth),
		buildSubagentSummary(params.session, cardWidth),
		buildLine(
			"created",
			normalizeTimestampLabel(params.session.time_created),
			cardWidth,
		),
		buildLine(
			"updated",
			normalizeTimestampLabel(params.session.time_updated),
			cardWidth,
		),
		buildLine("subagents", subagentSummary, cardWidth),
		buildLine("color", agentColorHint, cardWidth),
	];

	const maxContentRows = SESSION_CARD_MAX_HEIGHT - 2;
	const clipped = rows.slice(0, maxContentRows);
	const filled = [
		...clipped,
		...Array.from({ length: Math.max(0, maxContentRows - clipped.length) }, () =>
			buildLine("", "", cardWidth),
		),
	];

	return [
		buildHeader("", cardWidth),
		...filled,
		buildHeader("", cardWidth),
	];
};

export const buildSessionCard = (params: SessionCardRenderOptions): SessionCardRenderResult => {
	const width = clampWidth(params.width);
	const state = normalizeCardStatus(params.session, params);
	const waitingPulse = state.isWaiting
		? (1 - Math.cos((Date.now() % WAITING_PULSE_INTERVAL_MS) / WAITING_PULSE_INTERVAL_MS * Math.PI * 2)) / 2
		: 0;

	return {
		width,
		lines: buildCardLines({
			width,
			session: params.session,
			status: state.resolvedStatus,
			isSelected: (params.isSelected ?? false) && (params.isActivePane ?? true),
			isWaiting: state.isWaiting,
			isRecentlyCompleted: state.recentlyCompleted,
			waitingPulse,
		}),
	};
};

export interface SessionCardPropsLegacy {
	session: Session;
	status?: SessionStatus;
	isSelected?: boolean;
	isActivePane?: boolean;
	isWaiting?: boolean;
	width?: number;
	onSelect?: (sessionId: string) => void;
}

export const SessionCard = (props: SessionCardPropsLegacy) => {
	return buildSessionCard(props);
};

export default SessionCard;
