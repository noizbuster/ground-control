import { Box, bold, dim, fg, ScrollBox, Text, t } from "@opentui/core";

import { getAgentColor } from "../config/colors";
import { type Session, SessionStatus } from "../types";

type PanelSize = number | `${number}%` | "100%";

export interface DetailPanelProps {
	session?: Session | null;
	messageCount?: number;
	agents?: string[];
	status?: SessionStatus;
	summary?: string;
	width?: PanelSize;
	height?: PanelSize;
}

const PANEL_COLORS = {
	border: "#334155",
	surface: "#0F172A",
	sectionBorder: "#1E293B",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
} as const;

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

	return orderedAgents.filter((agent) => {
		const normalized = agent.trim().toLowerCase();
		if (seen.has(normalized)) {
			return false;
		}

		seen.add(normalized);
		return true;
	});
};

const getStatus = (
	session?: Session | null,
	status?: SessionStatus,
): SessionStatus => {
	return status ?? session?.status ?? SessionStatus.unknown;
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

	const fragments = [
		`${STATUS_LABEL_MAP[status]} session`,
		typeof messageCount === "number" && Number.isFinite(messageCount)
			? `${messageCount.toLocaleString("en-US")} messages`
			: "message count unavailable",
		session?.subagentSessions?.length
			? `${session.subagentSessions.length} subagents attached`
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
		}),
		Text({
			content: value,
			fg: PANEL_COLORS.text,
		}),
	);
};

const SubagentRow = (session: Session) => {
	const status = session.status ?? SessionStatus.unknown;
	const title = session.title.trim() || "Untitled subagent session";
	const agent = session.currentAgent?.trim() || "unknown";

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
		}),
		Text({
			content: t`${dim("status ")}${fg(STATUS_COLOR_MAP[status])(STATUS_LABEL_MAP[status])}`,
			fg: PANEL_COLORS.muted,
		}),
		Text({
			content: t`${dim("agent  ")}${fg(getAgentColor(agent))(agent)}`,
			fg: PANEL_COLORS.muted,
		}),
		Text({
			content: t`${dim("id     ")}${session.id}`,
			fg: PANEL_COLORS.muted,
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
		}),
		Box({ height: 1 }),
		...children,
	);
};

export const DetailPanel = ({
	session,
	messageCount,
	agents,
	status,
	summary,
	width = "100%",
	height = "100%",
}: DetailPanelProps) => {
	const sessionStatus = getStatus(session, status);
	const agentList = uniqueAgents(session, agents);
	const subagentSessions = session?.subagentSessions ?? [];
	const sessionTitle = session?.title?.trim() || "No session selected";
	const summaryText = getSummaryText({
		session,
		status: sessionStatus,
		messageCount,
		agents: agentList,
		summary,
	});

	return ScrollBox(
		{
			width,
			height,
			border: true,
			borderColor: PANEL_COLORS.border,
			backgroundColor: PANEL_COLORS.surface,
			padding: 1,
		},
		Box(
			{
				width: "100%",
				flexDirection: "column",
			},
			Text({
				content: t`${bold(sessionTitle)}`,
				fg: PANEL_COLORS.text,
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
								`Current ${session.currentAgent}`,
								getAgentColor(session.currentAgent),
							),
						]
					: []),
			),
			Section(
				"Overview",
				Text({
					content: summaryText,
					fg: PANEL_COLORS.muted,
				}),
				Box({ height: 1 }),
				DetailRow("Message count", formatOptionalNumber(messageCount)),
				DetailRow("Subagents", String(subagentSessions.length)),
				DetailRow("Last updated", formatTimestamp(session?.time_updated)),
			),
			Section(
				"Session Metadata",
				DetailRow("Session ID", session?.id ?? "Unavailable"),
				DetailRow("Title", session?.title ?? "Unavailable"),
				DetailRow("Directory", session?.directory ?? "Unavailable"),
				DetailRow("Project ID", session?.project_id ?? "Unavailable"),
				DetailRow("Created", formatTimestamp(session?.time_created)),
				DetailRow("Updated", formatTimestamp(session?.time_updated)),
				DetailRow("Status", STATUS_LABEL_MAP[sessionStatus]),
			),
			Section(
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
						}),
			),
			Section(
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
						}),
			),
		),
	);
};

export default DetailPanel;
