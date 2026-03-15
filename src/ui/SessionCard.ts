import { Box, bold, dim, fg, MouseButton, Text, t } from "@opentui/core";

import { getAgentColor, getAgentDisplayName } from "../config/colors";
import { type Session, SessionStatus } from "../types";

const CARD_WIDTH = 38;
const MIN_CARD_WIDTH = 30;
const CONTENT_WIDTH_OFFSET = 4;
export const SESSION_CARD_MAX_HEIGHT = 15;

const CARD_COLORS = {
	background: "#0F1720",
	selectedBackground: "#18253A",
	recentCompletedBackground: "#11241A",
	recentCompletedSelectedBackground: "#183527",
	title: "#E2E8F0",
	selectedTitle: "#F8FAFC",
	meta: "#94A3B8",
	selectedAccent: "#F59E0B",
	waitingEdge: "#FBBF24",
	recentCompletedEdge: "#4ADE80",
} as const;

const WAITING_PULSE_INTERVAL_MS = 2200;
const RECENT_COMPLETION_WINDOW_MS = 5 * 60 * 1000;

const STATUS_COLORS: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "#94A3B8",
	[SessionStatus.running]: "#60A5FA",
	[SessionStatus.waiting]: "#FBBF24",
	[SessionStatus.completed]: "#34D399",
	[SessionStatus.failed]: "#F87171",
	[SessionStatus.unknown]: "#94A3B8",
};

const clampChannel = (value: number): number =>
	Math.max(0, Math.min(255, Math.round(value)));

const parseHexColor = (value: string): [number, number, number] => {
	const normalized = value.replace("#", "");
	const hex =
		normalized.length === 3
			? normalized
					.split("")
					.map((segment) => `${segment}${segment}`)
					.join("")
			: normalized;

	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
};

const interpolateHexColor = (
	fromColor: string,
	toColor: string,
	strength: number,
): `#${string}` => {
	const [fromR, fromG, fromB] = parseHexColor(fromColor);
	const [toR, toG, toB] = parseHexColor(toColor);
	const mix = Math.max(0, Math.min(1, strength));

	const red = clampChannel(fromR + (toR - fromR) * mix)
		.toString(16)
		.padStart(2, "0");
	const green = clampChannel(fromG + (toG - fromG) * mix)
		.toString(16)
		.padStart(2, "0");
	const blue = clampChannel(fromB + (toB - fromB) * mix)
		.toString(16)
		.padStart(2, "0");

	return `#${red}${green}${blue}`;
};

export interface SessionCardProps {
	session: Session;
	status?: SessionStatus;
	isSelected?: boolean;
	isActivePane?: boolean;
	isWaiting?: boolean;
	width?: number;
	onSelect?: (sessionId: string) => void;
}

const clampWidth = (width?: number): number => {
	if (typeof width !== "number" || !Number.isFinite(width)) {
		return CARD_WIDTH;
	}

	return Math.max(MIN_CARD_WIDTH, Math.floor(width));
};

const truncateText = (value: string, maxLength: number): string => {
	if (maxLength <= 3) {
		return value.slice(0, Math.max(maxLength, 0));
	}

	if (value.length <= maxLength) {
		return value;
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

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const formatTimestamp = (value: number): string => {
	const normalized = normalizeTimestamp(value);
	if (normalized === null) {
		return "--";
	}

	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) {
		return "--";
	}

	return [
		date.getFullYear(),
		"-",
		pad2(date.getMonth() + 1),
		"-",
		pad2(date.getDate()),
		" ",
		pad2(date.getHours()),
		":",
		pad2(date.getMinutes()),
	].join("");
};

const formatStatus = (status: SessionStatus): string =>
	status === SessionStatus.waiting ? "AWAITING USER" : status.toUpperCase();

const buildWaitingEdge = (contentWidth: number): string => {
	const edgeWidth = Math.max(contentWidth, 11);
	const label = "[awaiting user]";

	if (edgeWidth <= label.length + 2) {
		return truncateText(label, edgeWidth);
	}

	return `${label}${"-".repeat(edgeWidth - label.length)}`;
};

const buildRecentCompletionEdge = (contentWidth: number): string => {
	const edgeWidth = Math.max(contentWidth, 18);
	const label = "[recently completed]";

	if (edgeWidth <= label.length + 2) {
		return truncateText(label, edgeWidth);
	}

	return `${label}${"+".repeat(edgeWidth - label.length)}`;
};

const buildSubagentSummary = (session: Session, maxLength: number): string => {
	const subagents = session.subagentSessions ?? [];
	if (subagents.length === 0) {
		return "none";
	}

	const labels = subagents.map((subagent) => {
		const agent = getAgentDisplayName(subagent.currentAgent);
		return agent && agent.length > 0
			? agent
			: subagent.title.trim() || "unknown";
	});

	return truncateText(labels.join(", "), maxLength);
};

const getRunningSubagentCount = (session: Session): number => {
	return (session.subagentSessions ?? []).filter(
		(subagent) => subagent.status === SessionStatus.running,
	).length;
};

export function SessionCard(props: SessionCardProps) {
	const width = clampWidth(props.width);
	const contentWidth = width - CONTENT_WIDTH_OFFSET;

	const session = props.session;
	const currentAgent = getAgentDisplayName(session.currentAgent);
	const resolvedStatus: SessionStatus =
		props.status ??
		session.status ??
		(props.isWaiting ? SessionStatus.waiting : SessionStatus.unknown);
	const isWaiting = props.isWaiting ?? resolvedStatus === SessionStatus.waiting;
	const status: SessionStatus = isWaiting
		? SessionStatus.waiting
		: resolvedStatus;
	const agentColor = getAgentColor(session.currentAgent);
	const waitingPulsePhase = isWaiting
		? (Date.now() % WAITING_PULSE_INTERVAL_MS) / WAITING_PULSE_INTERVAL_MS
		: 0;
	const waitingPulseStrength = isWaiting
		? (1 - Math.cos(waitingPulsePhase * Math.PI * 2)) / 2
		: 0;
	const updatedAt = normalizeTimestamp(session.time_updated);
	const isRecentlyCompleted =
		status === SessionStatus.completed &&
		updatedAt !== null &&
		Date.now() - updatedAt <= RECENT_COMPLETION_WINDOW_MS;
	const borderColor = isWaiting
		? interpolateHexColor(
				agentColor,
				CARD_COLORS.waitingEdge,
				waitingPulseStrength,
			)
		: isRecentlyCompleted
			? CARD_COLORS.recentCompletedEdge
			: agentColor;
	const isActiveSelection = props.isSelected && (props.isActivePane ?? true);
	const borderStyle =
		isActiveSelection || isRecentlyCompleted ? "heavy" : "rounded";

	const title = truncateText(
		session.title.trim() || "Untitled session",
		contentWidth,
	);
	const shortId = shortenMiddle(
		session.id || "unknown-session",
		Math.min(contentWidth, 18),
	);
	const projectLabel =
		session.project_label || session.project_id || "unknown-project";
	const shortProjectLabel = shortenMiddle(
		projectLabel,
		Math.min(contentWidth, 22),
	);
	const directoryLabel = shortenDirectoryPath(
		session.directory,
		Math.max(contentWidth - 7, 8),
	);
	const agentLabel = truncateText(currentAgent, Math.max(contentWidth - 7, 8));
	const runningSubagentCount = getRunningSubagentCount(session);
	const subagentCount = session.subagentSessions?.length ?? 0;
	const subagentLabel = buildSubagentSummary(
		session,
		Math.max(contentWidth - 10, 8),
	);
	const statusLabel = formatStatus(status);
	const statusColor = STATUS_COLORS[status];
	const waitingEdge = buildWaitingEdge(contentWidth);

	const idLine = isActiveSelection
		? t`${dim(shortId)} ${bold(fg(CARD_COLORS.selectedAccent)("[selected]"))}`
		: t`${dim(shortId)}`;

	const statusLine = t`${dim("status  ")}${bold(fg(statusColor)(statusLabel))}`;

	const waitingEdgeLine = isWaiting
		? t`${bold(fg(interpolateHexColor(CARD_COLORS.meta, CARD_COLORS.waitingEdge, waitingPulseStrength))(waitingEdge))}`
		: undefined;
	const recentCompletionEdgeLine = isRecentlyCompleted
		? t`${bold(fg(CARD_COLORS.recentCompletedEdge)(buildRecentCompletionEdge(contentWidth)))}`
		: undefined;
	const agentLine = t`${dim("agent   ")}${fg(agentColor)(agentLabel)}`;
	const subagentLine = t`${dim("subagents ")}${fg(CARD_COLORS.title)(`${runningSubagentCount} / ${subagentCount}`)}`;
	const subagentAgentsLine = t`${dim("nested  ")}${fg(CARD_COLORS.title)(subagentLabel)}`;
	const directoryLine = t`${dim("dir     ")}${fg(CARD_COLORS.title)(directoryLabel)}`;
	const projectLine = t`${dim("project ")}${fg(CARD_COLORS.title)(shortProjectLabel)}`;
	const createdLine = t`${dim("created ")}${fg(CARD_COLORS.title)(formatTimestamp(session.time_created))}`;
	const updatedLine = t`${dim("updated ")}${fg(CARD_COLORS.title)(formatTimestamp(session.time_updated))}`;

	return Box(
		{
			width,
			border: true,
			borderStyle,
			borderColor,
			backgroundColor: isActiveSelection
				? isRecentlyCompleted
					? CARD_COLORS.recentCompletedSelectedBackground
					: CARD_COLORS.selectedBackground
				: isRecentlyCompleted
					? CARD_COLORS.recentCompletedBackground
					: CARD_COLORS.background,
			padding: 1,
			flexDirection: "column",
			gap: 0,
			onMouseDown: (event) => {
				if (event.button !== MouseButton.LEFT || event.isDragging) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				props.onSelect?.(session.id);
			},
		},
		...(waitingEdgeLine
			? [
					Text({
						content: waitingEdgeLine,
						width: contentWidth,
					}),
				]
			: []),
		...(recentCompletionEdgeLine
			? [
					Text({
						content: recentCompletionEdgeLine,
						width: contentWidth,
					}),
				]
			: []),
		Text({
			content: t`${bold(fg(isActiveSelection ? CARD_COLORS.selectedTitle : CARD_COLORS.title)(title))}`,
			width: contentWidth,
		}),
		Text({
			content: idLine,
			width: contentWidth,
			fg: CARD_COLORS.meta,
		}),
		Text({
			content: statusLine,
			width: contentWidth,
		}),
		Text({
			content: agentLine,
			width: contentWidth,
		}),
		Text({
			content: subagentLine,
			width: contentWidth,
		}),
		Text({
			content: subagentAgentsLine,
			width: contentWidth,
		}),
		Text({
			content: projectLine,
			width: contentWidth,
		}),
		Text({
			content: directoryLine,
			width: contentWidth,
		}),
		Text({
			content: createdLine,
			width: contentWidth,
		}),
		Text({
			content: updatedLine,
			width: contentWidth,
		}),
	);
}
