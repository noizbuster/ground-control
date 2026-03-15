import { Box, bold, dim, fg, ScrollBox, Text, t } from "@opentui/core";

import { getAgentColor, getAgentDisplayName } from "../config/colors";
import { type Session, SessionStatus } from "../types";

type PanelSize = number | `${number}%` | "100%";

export interface DetailPanelProps {
	session?: Session | null;
	messageCount?: number;
	agents?: string[];
	status?: SessionStatus;
	summary?: string;
	scrollBoxId?: string;
	width?: PanelSize;
	height?: PanelSize;
}

export interface DetailPanelContentProps {
	session?: Session | null;
	messageCount?: number;
	agents?: string[];
	status?: SessionStatus;
	summary?: string;
	width?: PanelSize;
}

const PANEL_COLORS = {
	border: "#334155",
	surface: "#0F172A",
	sectionBorder: "#1E293B",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
} as const;

const DETAIL_TWO_COLUMN_MIN_WIDTH = 96;
const DETAIL_COLUMN_GAP = 2;

const STATUS_COLOR_MAP: Record<SessionStatus, `#${string}`> = {
	[SessionStatus.pending]: "#F59E0B",
	[SessionStatus.running]: "#3B82F6",
	[SessionStatus.waiting]: "#F97316",
	[SessionStatus.completed]: "#22C55E",
	[SessionStatus.failed]: "#EF4444",
	[SessionStatus.unknown]: "#64748B",
};

const STATUS_LABEL_MAP: Record<SessionStatus, string> = {
	[SessionStatus.pending]: "Pending",
	[SessionStatus.running]: "Running",
	[SessionStatus.waiting]: "Waiting",
	[SessionStatus.completed]: "Completed",
	[SessionStatus.failed]: "Failed",
	[SessionStatus.unknown]: "Unknown",
};

const normalizeTimestamp = (value: number): number | null => {
	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const formatTimestamp = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "Unknown";
	}

	const normalized = normalizeTimestamp(value);
	if (normalized === null) {
		return "Unknown";
	}

	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) {
		return "Unknown";
	}

	return date.toISOString();
};

const formatOptionalNumber = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "Not provided";
	}

	return value.toLocaleString("en-US");
};

const uniqueAgents = (
	session?: Session | null,
	agents?: string[],
): string[] => {
	const orderedAgents = [...(agents ?? []), session?.currentAgent].filter(
		(agent): agent is string =>
			typeof agent === "string" && agent.trim().length > 0,
	);

	const seen = new Set<string>();

	return orderedAgents
		.filter((agent) => {
			const normalized = getAgentDisplayName(agent).trim().toLowerCase();
			if (seen.has(normalized)) {
				return false;
			}

			seen.add(normalized);
			return true;
		})
		.map((agent) => getAgentDisplayName(agent));
};

const getStatus = (
	session?: Session | null,
	status?: SessionStatus,
): SessionStatus => {
	return status ?? session?.status ?? SessionStatus.unknown;
};

const getRunningSubagentCount = (session?: Session | null): number => {
	return (session?.subagentSessions ?? []).filter(
		(subagent) => subagent.status === SessionStatus.running,
	).length;
};

const getSubagentStatusRank = (status?: SessionStatus): number => {
	switch (status) {
		case SessionStatus.running:
			return 0;
		case SessionStatus.completed:
			return 1;
		default:
			return 2;
	}
};

const sortSubagentSessions = (subagentSessions: Session[]): Session[] => {
	return [...subagentSessions].sort((left, right) => {
		const leftRank = getSubagentStatusRank(left.status);
		const rightRank = getSubagentStatusRank(right.status);

		if (leftRank !== rightRank) {
			return leftRank - rightRank;
		}

		if (left.time_created !== right.time_created) {
			return right.time_created - left.time_created;
		}

		return left.id.localeCompare(right.id);
	});
};

const shouldUseTwoColumnLayout = (width?: PanelSize): boolean => {
	return typeof width === "number" && width >= DETAIL_TWO_COLUMN_MIN_WIDTH;
};

const getTwoColumnWidth = (width?: PanelSize): number | undefined => {
	if (typeof width !== "number") {
		return undefined;
	}

	return Math.max(Math.floor((width - DETAIL_COLUMN_GAP) / 2), 36);
};

const getSummaryText = (params: {
	session?: Session | null;
	status: SessionStatus;
	messageCount?: number;
	agents: string[];
	summary?: string;
}): string => {
	const { session, status, messageCount, agents, summary } = params;

	if (summary && summary.trim().length > 0) {
		return summary.trim();
	}

	if (!session) {
		return "Select a session to inspect its metadata, status, and agent activity.";
	}

	const runningSubagentCount = getRunningSubagentCount(session);

	const fragments = [
		`${STATUS_LABEL_MAP[status]} session`,
		typeof messageCount === "number" && Number.isFinite(messageCount)
			? `${messageCount.toLocaleString("en-US")} messages`
			: "message count unavailable",
		session?.subagentSessions?.length
			? `${runningSubagentCount} / ${session.subagentSessions.length} subagents running`
			: "no subagents attached",
		agents.length > 0
			? `${agents.length} agents recorded`
			: "no agents recorded",
	];

	return `${fragments.join(" - ")}. Last updated ${formatTimestamp(session.time_updated)}.`;
};

const DetailRow = (label: string, value: string) => {
	return Box(
		{
			width: "100%",
			flexDirection: "column",
			marginBottom: 1,
		},
		Text({
			content: t`${dim(label.toUpperCase())}`,
			fg: PANEL_COLORS.muted,
			width: "100%",
		}),
		Text({
			content: value,
			fg: PANEL_COLORS.text,
			width: "100%",
			wrapMode: "word",
		}),
	);
};

const SubagentRow = (session: Session) => {
	const status = session.status ?? SessionStatus.unknown;
	const title = session.title.trim() || "Untitled subagent session";
	const agent = getAgentDisplayName(session.currentAgent);

	return Box(
		{
			width: "100%",
			flexDirection: "column",
			border: true,
			borderColor: PANEL_COLORS.sectionBorder,
			padding: 1,
			marginBottom: 1,
		},
		Text({
			content: t`${bold(fg(PANEL_COLORS.text)(title))}`,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("status ")}${fg(STATUS_COLOR_MAP[status])(STATUS_LABEL_MAP[status])}`,
			fg: PANEL_COLORS.muted,
			width: "100%",
		}),
		Text({
			content: t`${dim("agent  ")}${fg(getAgentColor(agent))(agent)}`,
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: t`${dim("id     ")}${session.id}`,
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "char",
		}),
	);
};

const Badge = (label: string, color: `#${string}`) => {
	return Box(
		{
			border: true,
			borderColor: color,
			paddingLeft: 1,
			paddingRight: 1,
			marginRight: 1,
			marginBottom: 1,
		},
		Text({
			content: label,
			fg: color,
		}),
	);
};

type DetailPanelChild = ReturnType<typeof Box> | ReturnType<typeof Text>;

const Section = (title: string, ...children: DetailPanelChild[]) => {
	return Box(
		{
			width: "100%",
			flexDirection: "column",
			border: true,
			borderColor: PANEL_COLORS.sectionBorder,
			padding: 1,
			marginBottom: 1,
		},
		Text({
			content: t`${bold(fg(PANEL_COLORS.accent)(title))}`,
			width: "100%",
		}),
		Box({ height: 1 }),
		...children,
	);
};

export const createDetailPanelContent = ({
	session,
	messageCount,
	agents,
	status,
	summary,
	width,
}: DetailPanelContentProps) => {
	const sessionStatus = getStatus(session, status);
	const agentList = uniqueAgents(session, agents);
	const subagentSessions = sortSubagentSessions(
		session?.subagentSessions ?? [],
	);
	const runningSubagentCount = getRunningSubagentCount(session);
	const sessionTitle = session?.title?.trim() || "No session selected";
	const summaryText = getSummaryText({
		session,
		status: sessionStatus,
		messageCount,
		agents: agentList,
		summary,
	});
	const useTwoColumnLayout = shouldUseTwoColumnLayout(width);
	const columnWidth = getTwoColumnWidth(width);

	const overviewSection = Section(
		"Overview",
		Text({
			content: summaryText,
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Box({ height: 1 }),
		DetailRow("Message count", formatOptionalNumber(messageCount)),
		DetailRow(
			"Subagents",
			`${runningSubagentCount} / ${subagentSessions.length}`,
		),
		DetailRow("Last updated", formatTimestamp(session?.time_updated)),
	);

	const metadataSection = Section(
		"Session Metadata",
		DetailRow("Session ID", session?.id ?? "Unavailable"),
		DetailRow("Title", session?.title ?? "Unavailable"),
		DetailRow(
			"Project",
			session?.project_label ?? session?.project_id ?? "Unavailable",
		),
		DetailRow("Directory", session?.directory ?? "Unavailable"),
		DetailRow("Created", formatTimestamp(session?.time_created)),
		DetailRow("Updated", formatTimestamp(session?.time_updated)),
		DetailRow("Status", STATUS_LABEL_MAP[sessionStatus]),
	);

	const agentsSection = Section(
		"Agents",
		agentList.length > 0
			? Box(
					{
						width: "100%",
						flexDirection: "row",
						flexWrap: "wrap",
					},
					...agentList.map((agent) => Badge(agent, getAgentColor(agent))),
				)
			: Text({
					content: "No agents recorded for this session.",
					fg: PANEL_COLORS.muted,
					width: "100%",
					wrapMode: "word",
				}),
	);

	const subagentsSection = Section(
		"Subagents",
		subagentSessions.length > 0
			? Box(
					{
						width: "100%",
						flexDirection: "column",
					},
					...subagentSessions.map((subagent) => SubagentRow(subagent)),
				)
			: Text({
					content: "No subagent sessions recorded for this session.",
					fg: PANEL_COLORS.muted,
					width: "100%",
					wrapMode: "word",
				}),
	);

	const detailsLayout =
		useTwoColumnLayout && columnWidth
			? Box(
					{
						width: "100%",
						flexDirection: "row",
						alignItems: "flex-start",
						gap: DETAIL_COLUMN_GAP,
					},
					Box(
						{
							width: columnWidth,
							flexDirection: "column",
							flexShrink: 0,
						},
						overviewSection,
						metadataSection,
					),
					Box(
						{
							width: columnWidth,
							flexDirection: "column",
							flexShrink: 0,
						},
						agentsSection,
						subagentsSection,
					),
				)
			: Box(
					{
						width: "100%",
						flexDirection: "column",
					},
					overviewSection,
					metadataSection,
					agentsSection,
					subagentsSection,
				);

	return Box(
		{
			width: "100%",
			flexDirection: "column",
		},
		Text({
			content: t`${bold(sessionTitle)}`,
			fg: PANEL_COLORS.text,
			width: "100%",
			wrapMode: "word",
		}),
		Box({ height: 1 }),
		Box(
			{
				width: "100%",
				flexDirection: "row",
				flexWrap: "wrap",
			},
			Badge(STATUS_LABEL_MAP[sessionStatus], STATUS_COLOR_MAP[sessionStatus]),
			...(session?.currentAgent
				? [
						Badge(
							`Current ${getAgentDisplayName(session.currentAgent)}`,
							getAgentColor(session.currentAgent),
						),
					]
				: []),
		),
		detailsLayout,
	);
};

export const DetailPanel = ({
	session,
	messageCount,
	agents,
	status,
	summary,
	scrollBoxId,
	width = "100%",
	height = "100%",
}: DetailPanelProps) => {
	return ScrollBox(
		{
			id: scrollBoxId,
			width,
			height,
			border: true,
			borderColor: PANEL_COLORS.border,
			backgroundColor: PANEL_COLORS.surface,
			padding: 1,
		},
		createDetailPanelContent({
			session,
			messageCount,
			agents,
			status,
			summary,
			width,
		}),
	);
};

export default DetailPanel;
