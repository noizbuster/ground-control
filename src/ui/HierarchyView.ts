import { Box, bold, dim, fg, Text, t } from "@opentui/core";

import { getAgentColor, getAgentDisplayName } from "../config/colors";
import {
	buildHierarchyLines,
	type FlowIndentMeta,
	filterHierarchySession,
	getStatusLabel,
	getSubagentSummary,
	type HierarchyLine,
	sortSubagentsByStatus,
	type TreeIndentMeta,
	truncateLabelEnd,
} from "../lib/hierarchyHelpers";
import {
	type HierarchyFilterMode,
	type HierarchyInfoMode,
	type HierarchyViewMode,
	type Session,
	SessionStatus,
} from "../types";

type PanelSize = number | `${number}%` | "100%";

export interface HierarchyViewContentProps {
	session?: Session | null;
	messageCountBySessionId?: Partial<Record<string, number>>;
	viewMode?: HierarchyViewMode;
	infoMode?: HierarchyInfoMode;
	filterMode?: HierarchyFilterMode;
	width?: PanelSize;
	narrowMode?: boolean;
}

const VIEW_COLORS = {
	sectionBorder: "#1E293B",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
	flowAccent: "#F59E0B",
	empty: "#64748B",
} as const;

const FLOW_COLUMN_GAP = "     ";

const ROOT_TREE_PREFIX = {
	withChildren: "●─ ",
	withoutChildren: "●  ",
	detailWithChildren: "│  ",
	detailWithoutChildren: "   ",
} as const;

const STATUS_COLOR_MAP: Record<SessionStatus, `#${string}`> = {
	[SessionStatus.pending]: "#F59E0B",
	[SessionStatus.running]: "#3B82F6",
	[SessionStatus.waiting]: "#F97316",
	[SessionStatus.completed]: "#22C55E",
	[SessionStatus.failed]: "#EF4444",
	[SessionStatus.unknown]: "#64748B",
};

const VIEW_MODE_LABEL_MAP: Record<HierarchyViewMode, string> = {
	tree: "Tree",
	flow: "Flow",
};

const INFO_MODE_LABEL_MAP: Record<HierarchyInfoMode, string> = {
	standard: "Standard",
	detailed: "Detailed",
};

const FILTER_MODE_LABEL_MAP: Record<HierarchyFilterMode, string> = {
	latest: "Latest",
	active: "Active",
	all: "All",
};

type HierarchyViewChild = ReturnType<typeof Box> | ReturnType<typeof Text>;

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

const Section = (title: string, ...children: HierarchyViewChild[]) => {
	return Box(
		{
			width: "100%",
			flexDirection: "column",
			border: true,
			borderColor: VIEW_COLORS.sectionBorder,
			padding: 1,
			marginBottom: 1,
		},
		Text({
			content: t`${bold(fg(VIEW_COLORS.accent)(title))}`,
			width: "100%",
		}),
		Box({ height: 1 }),
		...children,
	);
};

const formatMessageCount = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "--";
	}

	return value.toLocaleString("en-US");
};

const formatSubagentCount = (value: number): string => {
	if (!Number.isFinite(value)) {
		return "--";
	}

	return value.toLocaleString("en-US");
};

const getTrimmedMetadataValue = (value?: string): string | null => {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const getModelLabel = (modelID?: string, variant?: string): string | null => {
	const model = getTrimmedMetadataValue(modelID);
	if (!model) {
		return null;
	}

	const modelVariant = getTrimmedMetadataValue(variant);
	return modelVariant ? `${model} / ${modelVariant}` : model;
};

const formatAgentBadgeLabel = (
	agentName: string,
	modelID?: string,
	variant?: string,
): string => {
	const modelLabel = getModelLabel(modelID, variant);
	return modelLabel
		? `Agent ${agentName} / ${modelLabel}`
		: `Agent ${agentName}`;
};

const formatRelativeTime = (epochMs: number | undefined): string => {
	if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
		return "--";
	}

	const diffMs = Date.now() - epochMs;
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

	return new Date(epochMs).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
};

const getFilterDescription = (
	filterMode: HierarchyFilterMode,
	visibleCount: number,
	totalCount: number,
): string | null => {
	if (totalCount === 0) {
		return null;
	}

	if (filterMode === "all") {
		return `Showing all ${totalCount} subagents`;
	}

	if (visibleCount === totalCount) {
		return `Showing all ${totalCount} subagents`;
	}

	if (filterMode === "active") {
		return `Showing ${visibleCount} active of ${totalCount} subagents`;
	}

	return `Showing ${visibleCount} of ${totalCount} subagents (active + latest terminal)`;
};

const getPreparedSession = (
	session: Session,
	filterMode: HierarchyFilterMode,
): Session => {
	const filteredSession = filterHierarchySession(session, filterMode);

	return {
		...filteredSession,
		subagentSessions: sortSubagentsByStatus(
			filteredSession.subagentSessions ?? [],
		),
	};
};

const getTreeIndent = (line: HierarchyLine): TreeIndentMeta => {
	return line.indent as TreeIndentMeta;
};

const getFlowIndent = (line: HierarchyLine): FlowIndentMeta => {
	return line.indent as FlowIndentMeta;
};

const getLinePrefix = (line: HierarchyLine): string => {
	if (line.node.isRoot) {
		return getTreeIndent(line).hasChildren
			? ROOT_TREE_PREFIX.withChildren
			: ROOT_TREE_PREFIX.withoutChildren;
	}

	return `${getTreeIndent(line).prefix} `;
};

const getDetailPrefix = (line: HierarchyLine): string => {
	if (line.node.isRoot) {
		return getTreeIndent(line).hasChildren
			? ROOT_TREE_PREFIX.detailWithChildren
			: ROOT_TREE_PREFIX.detailWithoutChildren;
	}

	const indent = getTreeIndent(line);
	const ancestorPrefix = indent.ancestorHasMore
		.map((hasMore) => (hasMore ? "│ " : "  "))
		.join("");
	const hasSiblingContinuation = !indent.isLastChild;
	const hasChildContinuation = indent.hasChildren;
	const currentConnector =
		hasSiblingContinuation && hasChildContinuation
			? "│ │"
			: hasSiblingContinuation
				? "│  "
				: hasChildContinuation
					? "  │"
					: "   ";

	return `${ancestorPrefix}${currentConnector}`;
};

const getFlowLinePrefix = (line: HierarchyLine): string => {
	const indent = getFlowIndent(line);
	const lanePrefix = FLOW_COLUMN_GAP.repeat(indent.columnIndex);

	if (line.node.isRoot) {
		return "entry ";
	}

	return `${lanePrefix}=> `;
};

const getFlowDetailPrefix = (line: HierarchyLine): string => {
	const indent = getFlowIndent(line);
	const lanePrefix = FLOW_COLUMN_GAP.repeat(indent.columnIndex);

	return `${lanePrefix}${line.node.isRoot ? "      " : "   | "}`;
};

const getDetailedMetadataContent = (
	prefix: string,
	detailedInfo: NonNullable<HierarchyLine["detailedInfo"]>,
	options: {
		includeDirectory?: boolean;
		includeProject?: boolean;
	} = {},
) => {
	const includeDirectory = options.includeDirectory ?? true;
	const includeProject = options.includeProject ?? true;
	const messageCount = formatMessageCount(detailedInfo.messageCount);
	const childCount = formatSubagentCount(detailedInfo.subagentCount);
	const directory = detailedInfo.directory
		? truncateLabelEnd(detailedInfo.directory, 32)
		: "--";
	const showProject = includeProject && Boolean(detailedInfo.projectLabel);

	return t`${fg(VIEW_COLORS.muted)(prefix)}${includeDirectory ? dim("dir ") : ""}${includeDirectory ? directory : ""}${includeDirectory ? dim("  ") : ""}${dim("msgs ")}${messageCount}${dim("  children ")}${childCount}${showProject ? dim("  project ") : ""}${showProject ? detailedInfo.projectLabel : ""}`;
};

const renderTreeHierarchyLine = (
	line: HierarchyLine,
	options: { showSpacer?: boolean } = {},
) => {
	const info = line.standardInfo;
	const agentName = getAgentDisplayName(info.agent);
	const modelLabel = getModelLabel(info.modelID, info.variant);
	const statusColor = STATUS_COLOR_MAP[info.status];
	const titleColor = line.node.isRoot ? VIEW_COLORS.accent : VIEW_COLORS.text;
	const title = line.node.title.trim() || "Untitled";
	const detailPrefix = getDetailPrefix(line);
	const showSpacer = options.showSpacer ?? false;
	const titleContent = t`${fg(VIEW_COLORS.muted)(getLinePrefix(line))}${bold(fg(titleColor)(title))}`;
	const metadataContent = t`${fg(VIEW_COLORS.muted)(detailPrefix)}${dim("status ")}${fg(statusColor)(getStatusLabel(info.status))}${dim("  agent ")}${fg(getAgentColor(info.agent))(agentName)}${modelLabel ? dim(" / ") : ""}${modelLabel ? fg(VIEW_COLORS.muted)(modelLabel) : ""}`;

	return Box(
		{
			width: "100%",
			flexDirection: "column",
		},
		Text({
			content: titleContent,
			width: "100%",
			wrapMode: "word",
			truncate: true,
		}),
		Text({
			content: metadataContent,
			width: "100%",
			wrapMode: "word",
			truncate: true,
		}),
		...(line.detailedInfo
			? [
					Text({
						content: t`${fg(VIEW_COLORS.muted)(detailPrefix)}${dim("id ")}${truncateLabelEnd(line.detailedInfo.id, 24)}${dim("  created ")}${formatRelativeTime(line.detailedInfo.timeCreated)}${dim("  updated ")}${formatRelativeTime(line.detailedInfo.timeUpdated)}`,
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
					}),
					Text({
						content: getDetailedMetadataContent(
							detailPrefix,
							line.detailedInfo,
							{ includeDirectory: false, includeProject: false },
						),
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
						truncate: true,
					}),
					...(showSpacer
						? [
								Text({
									content: t`${fg(VIEW_COLORS.muted)(detailPrefix)}`,
									width: "100%",
								}),
							]
						: []),
				]
			: []),
	);
};

const renderFlowHierarchyLine = (line: HierarchyLine) => {
	const info = line.standardInfo;
	const agentName = getAgentDisplayName(info.agent);
	const modelLabel = getModelLabel(info.modelID, info.variant);
	const statusColor = STATUS_COLOR_MAP[info.status];
	const titleColor = line.node.isRoot
		? VIEW_COLORS.flowAccent
		: VIEW_COLORS.text;
	const primaryContent = t`${fg(VIEW_COLORS.muted)(getFlowLinePrefix(line))}${bold(fg(titleColor)(info.title))}${dim("  status ")}${fg(statusColor)(getStatusLabel(info.status))}${dim("  agent ")}${fg(getAgentColor(info.agent))(agentName)}${modelLabel ? dim(" / ") : ""}${modelLabel ? fg(VIEW_COLORS.muted)(modelLabel) : ""}`;

	return Box(
		{
			width: "100%",
			flexDirection: "column",
			marginBottom: line.detailedInfo ? 1 : 0,
		},
		Text({
			content: primaryContent,
			width: "100%",
			wrapMode: "word",
			truncate: true,
		}),
		...(line.detailedInfo
			? [
					Text({
						content: t`${fg(VIEW_COLORS.muted)(getFlowDetailPrefix(line))}${dim("id ")}${truncateLabelEnd(line.detailedInfo.id, 24)}${dim("  created ")}${formatRelativeTime(line.detailedInfo.timeCreated)}${dim("  updated ")}${formatRelativeTime(line.detailedInfo.timeUpdated)}`,
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
					}),
					Text({
						content: getDetailedMetadataContent(
							getFlowDetailPrefix(line),
							line.detailedInfo,
						),
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
						truncate: true,
					}),
				]
			: []),
	);
};

const renderFlowHierarchy = (lines: HierarchyLine[]): HierarchyViewChild[] => {
	const children: HierarchyViewChild[] = [
		Text({
			content: t`${fg(VIEW_COLORS.flowAccent)("entry")} ${dim("fans left to right; wrapped rows continue below.")}`,
			fg: VIEW_COLORS.muted,
			width: "100%",
			wrapMode: "word",
		}),
		Box({ height: 1 }),
	];

	for (const line of lines) {
		const indent = getFlowIndent(line);

		if (indent.isContinuation) {
			children.push(
				Text({
					content: t`${fg(VIEW_COLORS.flowAccent)("  ||")} ${dim(`wrap to row ${indent.rowIndex + 1}`)}`,
					fg: VIEW_COLORS.muted,
					width: "100%",
					wrapMode: "word",
				}),
			);
		}

		children.push(renderFlowHierarchyLine(line));
	}

	return children;
};

export const createHierarchyViewContent = ({
	session,
	messageCountBySessionId,
	viewMode = "tree",
	infoMode = "standard",
	filterMode = "latest",
	width = "100%",
	narrowMode = false,
}: HierarchyViewContentProps): ReturnType<typeof Box> => {
	const preparedSession = session
		? getPreparedSession(session, filterMode)
		: null;
	const totalSubagentCount = session?.subagentSessions?.length ?? 0;
	const renderedLines = preparedSession
		? buildHierarchyLines(
				preparedSession,
				narrowMode ? "tree" : viewMode,
				infoMode,
				messageCountBySessionId,
			)
		: [];
	const visibleSubagentCount =
		renderedLines.length > 0 ? renderedLines.length - 1 : 0;
	const summary = preparedSession
		? getSubagentSummary(preparedSession)
		: { total: 0, active: 0, running: 0, terminal: 0 };
	const sessionTitle = preparedSession?.title?.trim() || "No session selected";
	const sessionStatus = preparedSession?.status ?? SessionStatus.unknown;
	const currentAgentName = getAgentDisplayName(preparedSession?.currentAgent);
	const activeViewMode = narrowMode ? "tree" : viewMode;
	const modeBadges = narrowMode
		? [
				Badge(
					`View ${VIEW_MODE_LABEL_MAP[activeViewMode]}`,
					VIEW_COLORS.accent,
				),
				Badge(
					`Filter ${FILTER_MODE_LABEL_MAP[filterMode]}`,
					VIEW_COLORS.accent,
				),
			]
		: [
				Badge(
					`View ${VIEW_MODE_LABEL_MAP[viewMode]}`,
					viewMode === "flow" ? VIEW_COLORS.flowAccent : VIEW_COLORS.accent,
				),
				Badge(`Info ${INFO_MODE_LABEL_MAP[infoMode]}`, VIEW_COLORS.accent),
				Badge(
					`Filter ${FILTER_MODE_LABEL_MAP[filterMode]}`,
					VIEW_COLORS.accent,
				),
			];

	return Box(
		{
			width,
			flexDirection: "column",
		},
		Section(
			"Agent Hierarchy",
			Text({
				content: t`${bold(fg(VIEW_COLORS.text)(narrowMode ? truncateLabelEnd(sessionTitle, 40) : sessionTitle))}`,
				fg: VIEW_COLORS.text,
				width: "100%",
				wrapMode: "word",
			}),
			Text({
				content: preparedSession
					? t`${dim("root id ")}${truncateLabelEnd(preparedSession.id, narrowMode ? 12 : 24)}${dim("  running ")}${summary.running.toLocaleString("en-US")} / ${summary.total.toLocaleString("en-US")}${dim("  active ")}${summary.active.toLocaleString("en-US")}`
					: "Select a session to inspect its subagent tree.",
				fg: preparedSession ? VIEW_COLORS.muted : VIEW_COLORS.empty,
				width: "100%",
				wrapMode: "word",
			}),
			Box(
				{
					width: "100%",
					flexDirection: "row",
					flexWrap: "wrap",
				},
				...(preparedSession
					? [
							Badge(
								getStatusLabel(sessionStatus),
								STATUS_COLOR_MAP[sessionStatus],
							),
							Badge(
								formatAgentBadgeLabel(
									currentAgentName,
									preparedSession.currentModelID,
									preparedSession.currentVariant,
								),
								getAgentColor(preparedSession.currentAgent),
							),
						]
					: []),
				...modeBadges,
			),
		),
		Section(
			activeViewMode === "flow" ? "Flow Graph" : "Tree",
			...(() => {
				const filterDesc = getFilterDescription(
					filterMode,
					visibleSubagentCount,
					totalSubagentCount,
				);
				if (!filterDesc) {
					return [];
				}
				return [
					Text({
						content: t`${dim(filterDesc)}`,
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
					}),
					Box({ height: 1 }),
				];
			})(),
			...(renderedLines.length > 0
				? activeViewMode === "flow"
					? renderFlowHierarchy(renderedLines)
					: renderedLines.map((line, index) =>
							renderTreeHierarchyLine(line, {
								showSpacer: index < renderedLines.length - 1,
							}),
						)
				: [
						Text({
							content: "Select a session to render its hierarchy.",
							fg: VIEW_COLORS.empty,
							width: "100%",
							wrapMode: "word",
						}),
					]),
		),
	);
};
