import { Box, blink, bold, dim, fg, Text, t } from "@opentui/core";

import { getAgentColor } from "../config/colors";
import { type Session, SessionStatus } from "../types";

const CARD_WIDTH = 38;
const MIN_CARD_WIDTH = 30;
const CONTENT_WIDTH_OFFSET = 4;

const CARD_COLORS = {
	background: "#0F1720",
	selectedBackground: "#18253A",
	title: "#E2E8F0",
	selectedTitle: "#F8FAFC",
	meta: "#94A3B8",
	selectedAccent: "#F59E0B",
	waitingEdge: "#FBBF24",
} as const;

const WAITING_BLINK_INTERVAL_MS = 500;

const STATUS_COLORS: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "#94A3B8",
	[SessionStatus.running]: "#60A5FA",
	[SessionStatus.waiting]: "#FBBF24",
	[SessionStatus.completed]: "#34D399",
	[SessionStatus.failed]: "#F87171",
	[SessionStatus.unknown]: "#94A3B8",
};

export interface SessionCardProps {
	session: Session;
	status?: SessionStatus;
	isSelected?: boolean;
	isWaiting?: boolean;
	width?: number;
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

const formatStatus = (status: SessionStatus): string => status.toUpperCase();

const buildWaitingEdge = (contentWidth: number): string => {
	const edgeWidth = Math.max(contentWidth, 11);
	const label = "[waiting]";

	if (edgeWidth <= label.length + 2) {
		return truncateText(label, edgeWidth);
	}

	return `${label}${"-".repeat(edgeWidth - label.length)}`;
};

const buildSubagentSummary = (session: Session, maxLength: number): string => {
	const subagents = session.subagentSessions ?? [];
	if (subagents.length === 0) {
		return "none";
	}

	const labels = subagents.map((subagent) => {
		const agent = subagent.currentAgent?.trim();
		return agent && agent.length > 0
			? agent
			: subagent.title.trim() || "unknown";
	});

	return truncateText(labels.join(", "), maxLength);
};

export function SessionCard(props: SessionCardProps) {
	const width = clampWidth(props.width);
	const contentWidth = width - CONTENT_WIDTH_OFFSET;

	const session = props.session;
	const currentAgent = session.currentAgent?.trim() || "unknown";
	const resolvedStatus: SessionStatus =
		props.status ??
		session.status ??
		(props.isWaiting ? SessionStatus.waiting : SessionStatus.unknown);
	const isWaiting = props.isWaiting ?? resolvedStatus === SessionStatus.waiting;
	const status: SessionStatus = isWaiting
		? SessionStatus.waiting
		: resolvedStatus;
	const agentColor = getAgentColor(currentAgent);
	const waitingBlinkOn =
		isWaiting && Math.floor(Date.now() / WAITING_BLINK_INTERVAL_MS) % 2 === 0;
	const borderColor = props.isSelected
		? CARD_COLORS.selectedAccent
		: isWaiting
			? waitingBlinkOn
				? CARD_COLORS.waitingEdge
				: agentColor
			: agentColor;

	const title = truncateText(
		session.title.trim() || "Untitled session",
		contentWidth,
	);
	const shortId = shortenMiddle(
		session.id || "unknown-session",
		Math.min(contentWidth, 18),
	);
	const agentLabel = truncateText(currentAgent, Math.max(contentWidth - 7, 8));
	const subagentCount = session.subagentSessions?.length ?? 0;
	const subagentLabel = buildSubagentSummary(
		session,
		Math.max(contentWidth - 10, 8),
	);
	const statusLabel = formatStatus(status);
	const statusColor = STATUS_COLORS[status];
	const waitingEdge = buildWaitingEdge(contentWidth);

	const idLine = props.isSelected
		? t`${dim(shortId)} ${bold(fg(CARD_COLORS.selectedAccent)("[selected]"))}`
		: t`${dim(shortId)}`;

	const statusLine = t`${dim("status  ")}${bold(fg(statusColor)(statusLabel))}`;

	const waitingEdgeLine = isWaiting
		? t`${blink(bold(fg(CARD_COLORS.waitingEdge)(waitingEdge)))}`
		: undefined;
	const agentLine = t`${dim("agent   ")}${fg(agentColor)(agentLabel)}`;
	const subagentLine = t`${dim("subagents ")}${fg(CARD_COLORS.title)(String(subagentCount))}`;
	const subagentAgentsLine = t`${dim("nested  ")}${fg(CARD_COLORS.title)(subagentLabel)}`;
	const createdLine = t`${dim("created ")}${fg(CARD_COLORS.title)(formatTimestamp(session.time_created))}`;
	const updatedLine = t`${dim("updated ")}${fg(CARD_COLORS.title)(formatTimestamp(session.time_updated))}`;

	return Box(
		{
			width,
			border: true,
			borderStyle: "rounded",
			borderColor,
			backgroundColor: props.isSelected
				? CARD_COLORS.selectedBackground
				: CARD_COLORS.background,
			padding: 1,
			flexDirection: "column",
			gap: 0,
		},
		...(waitingEdgeLine
			? [
					Text({
						content: waitingEdgeLine,
						width: contentWidth,
					}),
				]
			: []),
		Text({
			content: t`${bold(fg(props.isSelected ? CARD_COLORS.selectedTitle : CARD_COLORS.title)(title))}`,
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
			content: createdLine,
			width: contentWidth,
		}),
		Text({
			content: updatedLine,
			width: contentWidth,
		}),
	);
}
