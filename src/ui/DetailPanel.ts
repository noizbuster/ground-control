import { Box, bold, dim, fg, ScrollBox, Text, t } from "@opentui/core";

import { getAgentColor } from "../config/colors";
import {
	getDisplayStatus,
	getStatusLabel,
	getSubagentSummary,
} from "../lib/hierarchyHelpers";
import {
	getSessionCapabilitySummary,
	getSessionSourceColor,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import { type Session, SessionStatus } from "../types";
import { getSessionAgentDisplayName } from "./sessionAgentDisplay";

export type PanelSize = number | `${number}%` | "100%";
type MessageCountBySessionId = Partial<Record<string, number>>;
type RelationBasis = "project" | "directory" | "standalone";

interface RelatedSessionGroup {
	basis: RelationBasis;
	label: string;
	description: string;
	sessions: Session[];
	peers: Session[];
}

interface MetricCardData {
	label: string;
	value: string;
	note?: string;
	color?: `#${string}`;
}

export interface DetailPanelProps {
	session?: Session | null;
	messageCount?: number;
	sessions?: Session[];
	messageCountBySessionId?: MessageCountBySessionId;
	status?: SessionStatus;
	summary?: string;
	scrollBoxId?: string;
	width?: PanelSize;
	height?: PanelSize;
}

export interface DetailPanelContentProps {
	session?: Session | null;
	messageCount?: number;
	sessions?: Session[];
	messageCountBySessionId?: MessageCountBySessionId;
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
	info: "#0EA5E9",
	success: "#22C55E",
	warning: "#F59E0B",
	danger: "#EF4444",
	teal: "#14B8A6",
	neutral: "#64748B",
} as const;

const DETAIL_TWO_COLUMN_MIN_WIDTH = 96;
const DETAIL_COLUMN_GAP = 2;
const DETAIL_TWO_COLUMN_MIN_METRIC_COLUMNS = 2;
const DETAIL_PANEL_SCROLLBOX_WRAPPER_PADDING = 2;
const DETAIL_PANEL_SCROLLBOX_SCROLLBAR_WIDTH = 2;

const STATUS_COLOR_MAP: Record<SessionStatus, `#${string}`> = {
	[SessionStatus.pending]: "#F59E0B",
	[SessionStatus.running]: "#3B82F6",
	[SessionStatus.waiting]: "#F97316",
	[SessionStatus.completed]: PANEL_COLORS.text,
	[SessionStatus.failed]: "#EF4444",
	[SessionStatus.unknown]: "#64748B",
};

const normalizeTimestamp = (value?: number): number | null => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const formatTimestamp = (value?: number): string => {
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

const formatAverageNumber = (value: number | null): string => {
	if (value === null || !Number.isFinite(value)) {
		return "--";
	}

	return value.toLocaleString("en-US", {
		maximumFractionDigits: value >= 100 ? 0 : 1,
	});
};

const formatPercent = (part: number, total: number): string => {
	if (total <= 0) {
		return "0%";
	}

	return `${Math.round((part / total) * 100)}%`;
};

const formatRelativeTime = (value?: number): string => {
	const normalized = normalizeTimestamp(value);
	if (normalized === null) {
		return "--";
	}

	const diffMs = Date.now() - normalized;
	const absDiffMs = Math.abs(diffMs);

	if (absDiffMs < 60_000) {
		return "<1m ago";
	}

	if (absDiffMs < 3_600_000) {
		return `${Math.floor(absDiffMs / 60_000)}m ago`;
	}

	if (absDiffMs < 86_400_000) {
		return `${Math.floor(absDiffMs / 3_600_000)}h ago`;
	}

	if (absDiffMs < 604_800_000) {
		return `${Math.floor(absDiffMs / 86_400_000)}d ago`;
	}

	return new Date(normalized).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
};

const getDurationMs = (
	startEpochMs?: number,
	endEpochMs?: number,
): number | null => {
	const start = normalizeTimestamp(startEpochMs);
	const end = normalizeTimestamp(endEpochMs);

	if (start === null || end === null) {
		return null;
	}

	return Math.max(end - start, 0);
};

const formatDurationMs = (durationMs: number | null | undefined): string => {
	if (
		durationMs === null ||
		durationMs === undefined ||
		!Number.isFinite(durationMs)
	) {
		return "--";
	}

	if (durationMs < 60_000) {
		return "<1m";
	}

	const totalMinutes = Math.floor(durationMs / 60_000);
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}

	const totalHours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	if (totalHours < 24) {
		return remainingMinutes > 0
			? `${totalHours}h ${remainingMinutes}m`
			: `${totalHours}h`;
	}

	const totalDays = Math.floor(totalHours / 24);
	const remainingHours = totalHours % 24;
	return remainingHours > 0
		? `${totalDays}d ${remainingHours}h`
		: `${totalDays}d`;
};

const formatSignedNumber = (value: number | null): string => {
	if (value === null || !Number.isFinite(value)) {
		return "--";
	}

	if (value === 0) {
		return "0";
	}

	const prefix = value > 0 ? "+" : "-";
	return `${prefix}${Math.abs(value).toLocaleString("en-US", {
		maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1,
	})}`;
};

const formatSignedDuration = (value: number | null): string => {
	if (value === null || !Number.isFinite(value)) {
		return "--";
	}

	if (value === 0) {
		return "0";
	}

	const prefix = value > 0 ? "+" : "-";
	return `${prefix}${formatDurationMs(Math.abs(value))}`;
};

const shouldNormalizeDirectoryCase = process.platform === "win32";

const normalizeDirectoryKey = (directory?: string): string => {
	const normalized = (directory ?? "").trim().replace(/[\\/]+$/gu, "");
	return shouldNormalizeDirectoryCase ? normalized.toLowerCase() : normalized;
};

const getStatus = (
	session?: Session | null,
	status?: SessionStatus,
): SessionStatus => {
	return status ?? session?.status ?? SessionStatus.unknown;
};

const getSessionMessageCountValue = (
	sessionId: string | undefined,
	messageCountBySessionId?: MessageCountBySessionId,
): number | undefined => {
	if (!sessionId) {
		return undefined;
	}

	const value = messageCountBySessionId?.[sessionId];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
};

const hasCompleteNumberSet = (
	values: Array<number | undefined>,
): values is number[] => {
	return values.every(
		(value): value is number =>
			typeof value === "number" && Number.isFinite(value),
	);
};

const sumNumberSet = (
	values: Array<number | undefined>,
): number | undefined => {
	if (!hasCompleteNumberSet(values)) {
		return undefined;
	}

	return values.reduce((sum, value) => sum + value, 0);
};

const collectSessionAgents = (session?: Session | null): string[] => {
	const agentNames = [
		...(typeof session?.currentAgent === "string" &&
		session.currentAgent.trim().length > 0
			? [
					getSessionAgentDisplayName(session.currentAgent, {
						isRoot: session.parent_id === null,
					}),
				]
			: []),
		...(session?.subagentSessions ?? [])
			.filter(
				(subagent) =>
					typeof subagent.currentAgent === "string" &&
					subagent.currentAgent.trim().length > 0,
			)
			.map((subagent) =>
				getSessionAgentDisplayName(subagent.currentAgent, { isRoot: false }),
			),
	];

	const seen = new Set<string>();
	return agentNames.filter((agent) => {
		const normalized = agent.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) {
			return false;
		}

		seen.add(normalized);
		return true;
	});
};

const sortSessionsForDashboard = (sessions: Session[]): Session[] => {
	return [...sessions].sort((left, right) => {
		if (left.time_updated !== right.time_updated) {
			return right.time_updated - left.time_updated;
		}

		if (left.time_created !== right.time_created) {
			return right.time_created - left.time_created;
		}

		return left.id.localeCompare(right.id);
	});
};

const getRelatedSessionGroup = (
	session?: Session | null,
	sessions?: Session[],
): RelatedSessionGroup => {
	if (!session) {
		return {
			basis: "standalone",
			label: "Standalone",
			description:
				"Select a session to compare it against other sessions in the same workspace.",
			sessions: [],
			peers: [],
		};
	}

	const dedupedSessions = Array.from(
		new Map(
			(sessions ?? []).map((candidate) => [candidate.id, candidate]),
		).values(),
	);
	const baseSessions = dedupedSessions.some(
		(candidate) => candidate.id === session.id,
	)
		? dedupedSessions
		: [...dedupedSessions, session];
	const projectId = session.project_id?.trim();

	if (projectId) {
		const projectSessions = sortSessionsForDashboard(
			baseSessions.filter(
				(candidate) => candidate.project_id?.trim() === projectId,
			),
		);

		if (projectSessions.length > 1) {
			const projectLabel =
				session.project_label?.trim() || session.project_id || "this project";
			return {
				basis: "project",
				label: "Project cohort",
				description: `${projectSessions.length} root sessions share ${projectLabel}.`,
				sessions: projectSessions,
				peers: projectSessions.filter(
					(candidate) => candidate.id !== session.id,
				),
			};
		}
	}

	const directoryKey = normalizeDirectoryKey(session.directory);
	if (directoryKey) {
		const directorySessions = sortSessionsForDashboard(
			baseSessions.filter(
				(candidate) =>
					normalizeDirectoryKey(candidate.directory) === directoryKey,
			),
		);

		if (directorySessions.length > 1) {
			return {
				basis: "directory",
				label: "Directory cohort",
				description: `${directorySessions.length} root sessions share ${session.directory || "the same directory"}.`,
				sessions: directorySessions,
				peers: directorySessions.filter(
					(candidate) => candidate.id !== session.id,
				),
			};
		}
	}

	return {
		basis: "standalone",
		label: "Standalone",
		description:
			"No other root sessions currently share this project or directory.",
		sessions: [session],
		peers: [],
	};
};

const average = (values: number[]): number | null => {
	if (values.length === 0) {
		return null;
	}

	return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const getSessionRank = (
	targetSessionId: string | undefined,
	sessions: Session[],
	valueGetter: (session: Session) => number,
): number | null => {
	if (!targetSessionId || sessions.length === 0) {
		return null;
	}

	const ordered = [...sessions].sort((left, right) => {
		const leftValue = valueGetter(left);
		const rightValue = valueGetter(right);

		if (leftValue !== rightValue) {
			return rightValue - leftValue;
		}

		if (left.time_updated !== right.time_updated) {
			return right.time_updated - left.time_updated;
		}

		return left.id.localeCompare(right.id);
	});

	const index = ordered.findIndex(
		(candidate) => candidate.id === targetSessionId,
	);
	return index >= 0 ? index + 1 : null;
};

const formatRank = (rank: number | null, total: number): string => {
	if (rank === null || total <= 0) {
		return "--";
	}

	return `#${rank} / ${total}`;
};

const getLatestSubagentUpdate = (
	session?: Session | null,
): number | undefined => {
	return (session?.subagentSessions ?? []).reduce<number | undefined>(
		(latest, subagent) => {
			if (latest === undefined || subagent.time_updated > latest) {
				return subagent.time_updated;
			}

			return latest;
		},
		undefined,
	);
};

const describeAgentSample = (agents: string[]): string => {
	if (agents.length === 0) {
		return "No agents recorded";
	}

	if (agents.length <= 2) {
		return agents.join(", ");
	}

	return `${agents.slice(0, 2).join(", ")} +${agents.length - 2}`;
};

const shouldUseTwoColumnLayout = (width?: PanelSize): boolean => {
	if (typeof width !== "number" || width < DETAIL_TWO_COLUMN_MIN_WIDTH) {
		return false;
	}

	const columnWidth = getTwoColumnWidth(width);
	if (typeof columnWidth !== "number") {
		return false;
	}

	const metricContentWidth = Math.max(Math.floor(columnWidth) - 6, 18);
	return (
		getMetricColumnCount(metricContentWidth) >=
		DETAIL_TWO_COLUMN_MIN_METRIC_COLUMNS
	);
};

const getTwoColumnWidth = (width?: PanelSize): number | undefined => {
	if (typeof width !== "number") {
		return undefined;
	}

	return Math.max(Math.floor((width - DETAIL_COLUMN_GAP) / 2), 36);
};

const getMetricColumnCount = (width?: number): number => {
	if (typeof width !== "number" || !Number.isFinite(width)) {
		return 2;
	}

	if (width >= 78) {
		return 3;
	}

	if (width >= 42) {
		return 2;
	}

	return 1;
};

export const getDetailPanelContentWidth = (
	width: PanelSize,
	wrapperPadding: number,
	verticalScrollbarWidth = 0,
): PanelSize => {
	if (typeof width !== "number") {
		return width;
	}

	return Math.max(
		width - Math.floor(wrapperPadding) * 2 - Math.floor(verticalScrollbarWidth),
		1,
	);
};

const getSummaryText = (params: {
	session?: Session | null;
	status: SessionStatus;
	messageCount?: number;
	relatedGroup: RelatedSessionGroup;
	hierarchyTotal: number;
	hierarchyRunning: number;
	summary?: string;
	finishReason?: string;
}): string => {
	const {
		session,
		status,
		messageCount,
		relatedGroup,
		hierarchyTotal,
		hierarchyRunning,
		summary,
		finishReason,
	} = params;

	if (!session) {
		return "Select a session to inspect its dashboard, hierarchy health, and related-session trends.";
	}

	const fragments = [
		`${getStatusLabel(status, { runningSubagents: hierarchyRunning, finishReason })} session`,
		typeof messageCount === "number" && Number.isFinite(messageCount)
			? `${messageCount.toLocaleString("en-US")} messages`
			: "message count unavailable",
		hierarchyTotal > 0
			? `${hierarchyRunning} / ${hierarchyTotal} child sessions running`
			: "no child sessions attached",
		relatedGroup.peers.length > 0
			? `${relatedGroup.peers.length} related root sessions in the ${relatedGroup.label.toLowerCase()}`
			: "no related root sessions yet",
	];

	const generatedSummary = `${fragments.join(" - ")}. Last updated ${formatTimestamp(session.time_updated)}.`;
	if (summary && summary.trim().length > 0) {
		return `${summary.trim()} ${generatedSummary}`;
	}

	return generatedSummary;
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

const MetricItem = (metric: MetricCardData) => {
	const color = metric.color ?? PANEL_COLORS.accent;
	const noteText = metric.note?.trim();

	return Box(
		{
			width: "100%",
			flexDirection: "column",
			marginBottom: 1,
		},
		Text({
			content: t`${dim(metric.label.toUpperCase())}`,
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Text({
			content: noteText
				? t`${bold(fg(color)(metric.value))}${dim(` - ${noteText}`)}`
				: t`${bold(fg(color)(metric.value))}`,
			fg: PANEL_COLORS.text,
			width: "100%",
			wrapMode: "word",
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

const MetricGrid = (metrics: MetricCardData[]) => {
	return Box(
		{
			width: "100%",
			flexDirection: "column",
		},
		...metrics.map((metric) => MetricItem(metric)),
	);
};

export const createDetailPanelContent = ({
	session,
	messageCount,
	sessions,
	messageCountBySessionId,
	status,
	summary,
	width,
}: DetailPanelContentProps) => {
	const sessionStatus = getStatus(session, status);
	const sessionTitle = session?.title?.trim() || "No session selected";
	const sessionAgents = collectSessionAgents(session);
	const subagentSummary = session
		? getSubagentSummary(session)
		: { total: 0, active: 0, running: 0, terminal: 0 };
	const sessionDisplayStatus = getDisplayStatus(sessionStatus, {
		runningSubagents: subagentSummary.running,
		finishReason: session?.finishReason,
	});
	const sessionStatusLabel = getStatusLabel(sessionStatus, {
		runningSubagents: subagentSummary.running,
		finishReason: session?.finishReason,
	});
	const shouldShowCurrentAgent =
		session !== undefined &&
		session !== null &&
		(session.parent_id === null ||
			(typeof session.currentAgent === "string" &&
				session.currentAgent.trim().length > 0));
	const currentAgentName = shouldShowCurrentAgent
		? getSessionAgentDisplayName(session.currentAgent, {
				isRoot: session.parent_id === null,
			})
		: "Unavailable";
	const relatedGroup = getRelatedSessionGroup(session, sessions);
	const rootMessageCount =
		typeof messageCount === "number" && Number.isFinite(messageCount)
			? messageCount
			: getSessionMessageCountValue(session?.id, messageCountBySessionId);
	const currentDurationMs = getDurationMs(
		session?.time_created,
		session?.time_updated,
	);
	const childMessageCounts = (session?.subagentSessions ?? []).map((subagent) =>
		getSessionMessageCountValue(subagent.id, messageCountBySessionId),
	);
	const childMessageTotal = sumNumberSet(childMessageCounts);
	const hierarchyMessageTotal =
		typeof rootMessageCount === "number" &&
		typeof childMessageTotal === "number"
			? rootMessageCount + childMessageTotal
			: undefined;
	const cohortSessions = relatedGroup.sessions;
	const cohortMessageCounts = cohortSessions.map((candidate) =>
		getSessionMessageCountValue(candidate.id, messageCountBySessionId),
	);
	const hasCompleteCohortMessageData =
		hasCompleteNumberSet(cohortMessageCounts);
	const cohortDurationValues = cohortSessions
		.map((candidate) =>
			getDurationMs(candidate.time_created, candidate.time_updated),
		)
		.filter((value): value is number => value !== null);
	const cohortSubagentTotals = cohortSessions.map(
		(candidate) => getSubagentSummary(candidate).total,
	);
	const cohortAverageMessages = hasCompleteCohortMessageData
		? average(cohortMessageCounts)
		: null;
	const cohortAverageDurationMs = average(cohortDurationValues);
	const cohortAverageSubagents = average(cohortSubagentTotals);
	const latestSubagentUpdate = getLatestSubagentUpdate(session);
	const recencyRank = getSessionRank(
		session?.id,
		cohortSessions,
		(candidate) => candidate.time_updated,
	);
	const messageRank = getSessionRank(
		session?.id,
		cohortSessions,
		(candidate) =>
			getSessionMessageCountValue(candidate.id, messageCountBySessionId) ?? 0,
	);
	const hierarchyRank = getSessionRank(
		session?.id,
		cohortSessions,
		(candidate) => getSubagentSummary(candidate).total,
	);
	const effectiveMessageRank = hasCompleteCohortMessageData
		? messageRank
		: null;
	const summaryText = getSummaryText({
		session,
		status: sessionStatus,
		messageCount: rootMessageCount,
		relatedGroup,
		hierarchyTotal: subagentSummary.total,
		hierarchyRunning: subagentSummary.running,
		summary,
		finishReason: session?.finishReason,
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
		MetricGrid([
			{
				label: "Messages",
				value: formatOptionalNumber(rootMessageCount),
				note: session?.id ? `Root session ${session.id}` : "Select a session",
				color: PANEL_COLORS.accent,
			},
			{
				label: "Runtime",
				value: formatDurationMs(currentDurationMs),
				note: session
					? `Created ${formatRelativeTime(session.time_created)}`
					: "--",
				color: PANEL_COLORS.warning,
			},
			{
				label: "Last update",
				value: formatRelativeTime(session?.time_updated),
				note: formatTimestamp(session?.time_updated),
				color: STATUS_COLOR_MAP[sessionDisplayStatus],
			},
			{
				label: "Child sessions",
				value: `${subagentSummary.total}`,
				note:
					subagentSummary.total > 0
						? `${subagentSummary.active} active / ${subagentSummary.terminal} closed`
						: "No child sessions recorded",
				color: PANEL_COLORS.success,
			},
			{
				label: "Agent coverage",
				value: `${sessionAgents.length}`,
				note: describeAgentSample(sessionAgents),
				color: PANEL_COLORS.teal,
			},
			{
				label: "Related peers",
				value: `${relatedGroup.peers.length}`,
				note: relatedGroup.label,
				color: PANEL_COLORS.info,
			},
		]),
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
		DetailRow("Status", sessionStatusLabel),
		DetailRow("Finish reason", session?.finishReason ?? "—"),
		DetailRow("Provider", session?.providerID ?? "—"),
		DetailRow("Current agent", currentAgentName),
		DetailRow("Model", session?.currentModelID ?? "Unavailable"),
		DetailRow("Variant", session?.currentVariant ?? "Unavailable"),
		DetailRow("Related scope", relatedGroup.label),
	);

	const sourceSection = Section(
		"Source Metadata",
		DetailRow(
			"Source",
			session ? getSessionSourceLabel(session.sessionSource) : "Unavailable",
		),
		DetailRow("Status detail", session?.statusDetail ?? "—"),
		DetailRow("Capabilities", getSessionCapabilitySummary(session)),
		DetailRow("Source channel", session?.sourceMetadata?.sourceCategory ?? "—"),
		DetailRow("Originator", session?.sourceMetadata?.originator ?? "—"),
		DetailRow("CLI version", session?.sourceMetadata?.cliVersion ?? "—"),
		DetailRow("Agent role", session?.sourceMetadata?.agentRole ?? "—"),
		DetailRow("Agent nickname", session?.sourceMetadata?.agentNickname ?? "—"),
		DetailRow(
			"Reasoning",
			session?.currentReasoningEffort ??
				session?.sourceMetadata?.reasoningEffort ??
				"—",
		),
	);

	const hierarchySection = Section(
		"Hierarchy Stats",
		Text({
			content:
				subagentSummary.total > 0
					? `This session fans out into ${subagentSummary.total} child sessions. These stats replace the old child-session list with workload and completion signals.`
					: "This session has no child sessions yet, so the hierarchy metrics stay focused on the root session only.",
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Box({ height: 1 }),
		MetricGrid([
			{
				label: "Root messages",
				value: formatOptionalNumber(rootMessageCount),
				note: sessionTitle,
				color: PANEL_COLORS.accent,
			},
			{
				label: "Child messages",
				value: formatOptionalNumber(childMessageTotal),
				note:
					subagentSummary.total > 0 && typeof childMessageTotal === "number"
						? `${formatAverageNumber(
								childMessageTotal / subagentSummary.total,
							)} avg per child`
						: subagentSummary.total > 0
							? "Waiting for every child message count to load"
							: "No child messages yet",
				color: PANEL_COLORS.info,
			},
			{
				label: "Hierarchy total",
				value: formatOptionalNumber(hierarchyMessageTotal),
				note:
					typeof hierarchyMessageTotal === "number"
						? "Root + child messages"
						: "Waiting for root or child message counts",
				color: PANEL_COLORS.success,
			},
			{
				label: "Active children",
				value: `${subagentSummary.active}`,
				note: `${subagentSummary.running} running right now`,
				color: PANEL_COLORS.warning,
			},
			{
				label: "Closed children",
				value: `${subagentSummary.terminal}`,
				note: `${formatPercent(subagentSummary.terminal, subagentSummary.total)} completion rate`,
				color: PANEL_COLORS.teal,
			},
			{
				label: "Latest child activity",
				value: formatRelativeTime(latestSubagentUpdate),
				note:
					latestSubagentUpdate !== undefined
						? formatTimestamp(latestSubagentUpdate)
						: "No child-session updates yet",
				color: PANEL_COLORS.neutral,
			},
		]),
	);

	const benchmarksSection = Section(
		"Benchmarks",
		Text({
			content:
				cohortSessions.length > 1
					? `Current session ranks compare it against the ${relatedGroup.label.toLowerCase()} on freshness, message volume, and child-session fan-out.`
					: "Once more related sessions appear, this panel will rank the current session against them automatically.",
			fg: PANEL_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Box({ height: 1 }),
		MetricGrid([
			{
				label: "Update rank",
				value: formatRank(recencyRank, cohortSessions.length),
				note: `By last activity in the ${relatedGroup.label.toLowerCase()}`,
				color: PANEL_COLORS.info,
			},
			{
				label: "Message rank",
				value: formatRank(effectiveMessageRank, cohortSessions.length),
				note:
					cohortAverageMessages === null
						? "Message counts unavailable for at least one related session"
						: `Current ${formatOptionalNumber(rootMessageCount)} vs avg ${formatAverageNumber(cohortAverageMessages)}`,
				color: PANEL_COLORS.accent,
			},
			{
				label: "Hierarchy rank",
				value: formatRank(hierarchyRank, cohortSessions.length),
				note: `Current ${subagentSummary.total} children vs avg ${formatAverageNumber(cohortAverageSubagents)}`,
				color: PANEL_COLORS.success,
			},
			{
				label: "Messages vs avg",
				value: formatSignedNumber(
					cohortAverageMessages === null || rootMessageCount === undefined
						? null
						: rootMessageCount - cohortAverageMessages,
				),
				note:
					cohortAverageMessages === null
						? "Message counts unavailable in this cohort"
						: `Average ${formatAverageNumber(cohortAverageMessages)} per root session`,
				color: PANEL_COLORS.warning,
			},
			{
				label: "Children vs avg",
				value: formatSignedNumber(
					cohortAverageSubagents === null
						? null
						: subagentSummary.total - cohortAverageSubagents,
				),
				note: `Average ${formatAverageNumber(cohortAverageSubagents)} attached sessions`,
				color: PANEL_COLORS.teal,
			},
			{
				label: "Runtime vs avg",
				value: formatSignedDuration(
					currentDurationMs === null || cohortAverageDurationMs === null
						? null
						: currentDurationMs - cohortAverageDurationMs,
				),
				note: `Average ${formatDurationMs(cohortAverageDurationMs)} per root session`,
				color: STATUS_COLOR_MAP[sessionDisplayStatus],
			},
		]),
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
						hierarchySection,
					),
					Box(
						{
							width: columnWidth,
							flexDirection: "column",
							flexShrink: 0,
						},
						metadataSection,
						benchmarksSection,
					),
				)
			: Box(
					{
						width: "100%",
						flexDirection: "column",
					},
					overviewSection,
					metadataSection,
					sourceSection,
					hierarchySection,
					benchmarksSection,
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
			Badge(sessionStatusLabel, STATUS_COLOR_MAP[sessionDisplayStatus]),
			...(session
				? [
						Badge(
							getSessionSourceLabel(session.sessionSource),
							getSessionSourceColor(session.sessionSource),
						),
					]
				: []),
			...(session?.sourceMetadata?.sourceCategory
				? [Badge(session.sourceMetadata.sourceCategory, PANEL_COLORS.info)]
				: []),
			...(session?.currentReasoningEffort
				? [
						Badge(
							`Reasoning ${session.currentReasoningEffort}`,
							PANEL_COLORS.warning,
						),
					]
				: []),
			...(shouldShowCurrentAgent && session
				? [
						Badge(
							`Current ${currentAgentName}`,
							getAgentColor(session.currentAgent),
						),
					]
				: []),
			...(session
				? [
						Badge(
							`${relatedGroup.label}: ${relatedGroup.sessions.length}`,
							PANEL_COLORS.accent,
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
	sessions,
	messageCountBySessionId,
	status,
	summary,
	scrollBoxId,
	width = "100%",
	height = "100%",
}: DetailPanelProps) => {
	const contentWidth = getDetailPanelContentWidth(
		width,
		DETAIL_PANEL_SCROLLBOX_WRAPPER_PADDING,
		DETAIL_PANEL_SCROLLBOX_SCROLLBAR_WIDTH,
	);

	return ScrollBox(
		{
			id: scrollBoxId,
			width,
			height,
			border: true,
			borderColor: PANEL_COLORS.border,
			backgroundColor: PANEL_COLORS.surface,
			wrapperOptions: { padding: DETAIL_PANEL_SCROLLBOX_WRAPPER_PADDING },
		},
		createDetailPanelContent({
			session,
			messageCount,
			sessions,
			messageCountBySessionId,
			status,
			summary,
			width: contentWidth,
		}),
	);
};

export default DetailPanel;
