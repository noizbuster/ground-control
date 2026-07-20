import { Box, bold, dim, fg, MouseButton, Text, t } from "@opentui/core";

import { getAgentColor } from "../config/colors";
import {
	countRunningSubagents,
	getDisplayStatus,
	getStatusLabel,
} from "../lib/hierarchyHelpers";
import {
	isRecentlyCompleted,
	normalizeTimestamp,
} from "../lib/recentCompletion";
import {
	getSessionSourceColor,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import {
	formatInactiveDuration,
	getInactiveDurationMs,
	getStallLevel,
	type StallLevel,
} from "../lib/stallDetection";
import { type Session, SessionStatus } from "../types";
import { getSessionAgentDisplayName } from "./sessionAgentDisplay";

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
	meta: "#94A3B8",
	selectedAccent: "#F59E0B",
	waitingEdge: "#FBBF24",
	recentCompletedEdge: "#4ADE80",
	stalledEdge: "#F59E0B",
	blockedEdge: "#F87171",
} as const;

const STATUS_COLORS: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "#94A3B8",
	[SessionStatus.running]: "#60A5FA",
	[SessionStatus.waiting]: "#FBBF24",
	[SessionStatus.idle]: CARD_COLORS.title,
	[SessionStatus.completed]: CARD_COLORS.title,
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

export const shortenDirectoryPath = (
	value: string,
	maxLength: number,
): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		return "--";
	}

	if (trimmed.length <= maxLength) {
		return trimmed;
	}

	const segments = trimmed.split(/[\\/]+/u).filter(Boolean);
	if (segments.length === 0) {
		return truncateText(trimmed, maxLength);
	}

	const tail = segments.slice(-3).join("/");
	const preferred = segments.length > 3 ? `...${tail}` : tail;
	if (preferred.length <= maxLength) {
		return preferred;
	}

	if (maxLength <= 3) {
		return ".".repeat(maxLength);
	}

	return `...${tail.slice(-(maxLength - 3))}`;
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

const formatStatus = (
	status: SessionStatus,
	runningSubagents: number = 0,
	finishReason?: string,
): string => {
	const baseLabel = getStatusLabel(status, { runningSubagents, finishReason });
	if (status === SessionStatus.idle || baseLabel === "Idle") {
		return "COMPLETED";
	}
	if (status !== SessionStatus.waiting) {
		return baseLabel.toUpperCase();
	}

	return baseLabel === "Waiting" ? "AWAITING USER" : baseLabel.toUpperCase();
};

const buildWaitingEdge = (
	contentWidth: number,
	status: SessionStatus,
	finishReason?: string,
): string => {
	const edgeWidth = Math.max(contentWidth, 11);
	const waitingLabel = getStatusLabel(status, { finishReason });
	const label =
		waitingLabel === "Waiting"
			? "[awaiting user]"
			: waitingLabel === "Idle"
				? "[idle]"
				: `[${waitingLabel.toLowerCase()}]`;

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

const buildStallEdge = (
	contentWidth: number,
	level: Exclude<StallLevel, "none">,
	inactiveForMs?: number | null,
): string => {
	const edgeWidth = Math.max(contentWidth, 11);
	const baseLabel = level === "blocked" ? "[blocked]" : "[stalled]";
	const durationLabel =
		level === "blocked" &&
		typeof inactiveForMs === "number" &&
		Number.isFinite(inactiveForMs)
			? ` ${formatInactiveDuration(inactiveForMs)}`
			: "";
	const label = `${baseLabel}${durationLabel}`;

	if (edgeWidth <= label.length + 2) {
		return truncateText(label, edgeWidth);
	}

	return `${label}${"-".repeat(edgeWidth - label.length)}`;
};

const stallEdgeColor = (level: Exclude<StallLevel, "none">): string => {
	return level === "blocked"
		? CARD_COLORS.blockedEdge
		: CARD_COLORS.stalledEdge;
};

export function SessionCard(props: SessionCardProps) {
	const width = clampWidth(props.width);
	const contentWidth = width - CONTENT_WIDTH_OFFSET;

	const session = props.session;
	const currentAgent = getSessionAgentDisplayName(session.currentAgent, {
		isRoot: session.parent_id === null,
	});
	const resolvedStatus: SessionStatus =
		props.status ??
		session.status ??
		(props.isWaiting ? SessionStatus.waiting : SessionStatus.unknown);
	const isWaiting = props.isWaiting ?? resolvedStatus === SessionStatus.waiting;
	const status: SessionStatus = isWaiting
		? SessionStatus.waiting
		: resolvedStatus;
	const agentColor = getAgentColor(session.currentAgent);
	const runningSubagentCount = countRunningSubagents(session);
	const displayStatus = getDisplayStatus(status, {
		runningSubagents: runningSubagentCount,
		finishReason: session.finishReason,
	});
	const isIdleStatus =
		status === SessionStatus.idle || displayStatus === SessionStatus.idle;
	const showWaitingTreatment =
		!isIdleStatus &&
		isWaiting &&
		displayStatus === SessionStatus.waiting;
	const waitingEmphasisStrength = showWaitingTreatment ? 1 : 0;
	const nowMs = Date.now();
	const isRecentlyCompletedSession = isRecentlyCompleted(
		displayStatus,
		session.time_updated,
		nowMs,
		session.finishReason,
	);
	// Awaiting-user edge always wins over stalled/blocked when both apply.
	const stallLevel: StallLevel = showWaitingTreatment
		? "none"
		: getStallLevel(displayStatus, session, nowMs);
	const inactiveForMs =
		stallLevel === "blocked" ? getInactiveDurationMs(session, nowMs) : null;
	const borderColor = showWaitingTreatment
		? interpolateHexColor(
				agentColor,
				CARD_COLORS.waitingEdge,
				waitingEmphasisStrength,
			)
		: stallLevel !== "none"
			? stallEdgeColor(stallLevel)
			: isRecentlyCompletedSession
				? CARD_COLORS.recentCompletedEdge
				: agentColor;
	const isActiveSelection = props.isSelected && (props.isActivePane ?? true);
	const borderStyle =
		isActiveSelection || isRecentlyCompletedSession || stallLevel !== "none"
			? "heavy"
			: "rounded";

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
	const sourceLabel = getSessionSourceLabel(session.sessionSource);
	const sourceColor = getSessionSourceColor(session.sessionSource);
	const directoryLabel = shortenDirectoryPath(
		session.directory,
		Math.max(contentWidth - "dir     ".length, 1),
	);
	const agentLabel = truncateText(
		currentAgent,
		Math.max(
			contentWidth - "agent   ".length - sourceLabel.length - " · ".length,
			1,
		),
	);
	const subagentCount = session.subagentSessions?.length ?? 0;
	const statusLabel = formatStatus(
		status,
		runningSubagentCount,
		session.finishReason,
	);
	const statusColor = STATUS_COLORS[displayStatus];
	const waitingEdge = buildWaitingEdge(
		contentWidth,
		status,
		session.finishReason,
	);

	const idLine = t`${dim(shortId)}`;

	const statusLine = t`${dim("status  ")}${bold(fg(statusColor)(statusLabel))}`;

	const waitingEdgeLine = showWaitingTreatment
		? t`${bold(fg(interpolateHexColor(CARD_COLORS.meta, CARD_COLORS.waitingEdge, waitingEmphasisStrength))(waitingEdge))}`
		: undefined;
	const stallEdgeLine =
		stallLevel === "none"
			? undefined
			: t`${bold(fg(stallEdgeColor(stallLevel))(buildStallEdge(contentWidth, stallLevel, inactiveForMs)))}`;
	const recentCompletionEdgeLine =
		!showWaitingTreatment && stallLevel === "none" && isRecentlyCompletedSession
			? t`${bold(fg(CARD_COLORS.recentCompletedEdge)(buildRecentCompletionEdge(contentWidth)))}`
			: undefined;
	const agentLine = t`${dim("agent   ")}${fg(sourceColor)(sourceLabel)}${dim(" · ")}${fg(agentColor)(agentLabel)}`;
	const subagentLine = t`${dim("subagents ")}${fg(CARD_COLORS.title)(`${runningSubagentCount} / ${subagentCount}`)}`;
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
				? isRecentlyCompletedSession
					? CARD_COLORS.recentCompletedSelectedBackground
					: CARD_COLORS.selectedBackground
				: isRecentlyCompletedSession
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
		Text({
			content: t`${bold(fg(isActiveSelection ? CARD_COLORS.selectedAccent : CARD_COLORS.title)(title))}`,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: idLine,
			width: contentWidth,
			fg: CARD_COLORS.meta,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: statusLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: agentLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: subagentLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: projectLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: directoryLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: createdLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		Text({
			content: updatedLine,
			width: contentWidth,
			wrapMode: "none",
			truncate: true,
		}),
		...(waitingEdgeLine
			? [
					Text({
						content: waitingEdgeLine,
						width: contentWidth,
						wrapMode: "none",
						truncate: true,
					}),
				]
			: []),
		...(stallEdgeLine
			? [
					Text({
						content: stallEdgeLine,
						width: contentWidth,
						wrapMode: "none",
						truncate: true,
					}),
				]
			: []),
		...(recentCompletionEdgeLine
			? [
					Text({
						content: recentCompletionEdgeLine,
						width: contentWidth,
						wrapMode: "none",
						truncate: true,
					}),
				]
			: []),
	);
}
