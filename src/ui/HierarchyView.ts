import {
	Box,
	bold,
	dim,
	fg,
	MouseButton,
	StyledText,
	Text,
	t,
} from "@opentui/core";

import { getAgentColor } from "../config/colors";
import {
	buildHierarchyLines,
	countRunningSubagents,
	filterHierarchySession,
	getDisplayStatus,
	getStatusLabel,
	getSubagentSummary,
	type HierarchyLine,
	isActiveStatus,
	sortSubagentsByStatus,
	type TreeIndentMeta,
	truncateLabelEnd,
	truncateLabelStart,
} from "../lib/hierarchyHelpers";
import {
	getSessionSourceColor,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import {
	type HierarchyFilterMode,
	type HierarchyInfoMode,
	type HierarchyViewMode,
	type Session,
	SessionStatus,
} from "../types";
import { getSessionAgentDisplayName } from "./sessionAgentDisplay";

type PanelSize = number | `${number}%` | "100%";
type HierarchySectionMode = "all" | "header" | "body";

export interface HierarchyViewContentProps {
	session?: Session | null;
	messageCountBySessionId?: Partial<Record<string, number>>;
	viewMode?: HierarchyViewMode;
	infoMode?: HierarchyInfoMode;
	filterMode?: HierarchyFilterMode;
	timelineScrollLeft?: number;
	timelineViewportWidth?: number;
	width?: PanelSize;
	narrowMode?: boolean;
	timelineAxisAnchored?: boolean;
	sectionMode?: HierarchySectionMode;
	onCopyId?: (id: string) => void;
}

export interface HierarchyTimelineAnchorProps {
	session?: Session | null;
	viewMode?: HierarchyViewMode;
	infoMode?: HierarchyInfoMode;
	filterMode?: HierarchyFilterMode;
	timelineScrollLeft?: number;
	timelineViewportWidth?: number;
	narrowMode?: boolean;
}

const TIMELINE_INTRO_TEXT =
	"bars map created -> latest update, with endpoint shape reflecting status.";

const VIEW_COLORS = {
	sectionBorder: "#1E293B",
	text: "#E2E8F0",
	muted: "#94A3B8",
	accent: "#38BDF8",
	flowAccent: "#F59E0B",
	empty: "#64748B",
} as const;

const TIMELINE_TRACK_MIN_WIDTH = 96;
const TIMELINE_TRACK_SCROLL_PADDING_MIN = 12;
const TIMELINE_TRACK_SCROLL_PADDING_RATIO = 0.15;
const TIMELINE_CONTEXT_WIDTH_STANDARD = 3;
export const TIMELINE_CONTEXT_WIDTH = TIMELINE_CONTEXT_WIDTH_STANDARD;
const TIMELINE_AXIS_INTERVAL = 8;

export const getTimelineContextWidth = (
	_infoMode: HierarchyInfoMode = "standard",
): number => {
	return TIMELINE_CONTEXT_WIDTH_STANDARD;
};

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
	[SessionStatus.completed]: VIEW_COLORS.text,
	[SessionStatus.failed]: "#EF4444",
	[SessionStatus.unknown]: "#64748B",
};

const TIMELINE_STATUS_COLOR_MAP: Record<SessionStatus, `#${string}`> = {
	...STATUS_COLOR_MAP,
	[SessionStatus.completed]: "#64748B",
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
			marginBottom: 0,
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
			paddingTop: 1,
			paddingLeft: 1,
			paddingRight: 1,
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

const normalizeInlineText = (
	value: string | undefined,
	fallback: string,
): string => {
	if (typeof value !== "string") {
		return fallback;
	}

	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length > 0 ? normalized : fallback;
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

const clampNumber = (value: number, min: number, max: number): number => {
	return Math.max(min, Math.min(max, value));
};

const normalizeTimestamp = (value?: number): number | null => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const formatRelativeTime = (epochMs: number | undefined): string => {
	const normalized = normalizeTimestamp(epochMs);
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

const formatDuration = (
	startEpochMs: number | undefined,
	endEpochMs: number | undefined,
): string => {
	const start = normalizeTimestamp(startEpochMs);
	const end = normalizeTimestamp(endEpochMs);

	if (start === null || end === null) {
		return "--";
	}

	const durationMs = Math.max(end - start, 0);
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

const formatTimelineMinutes = (minutes: number | null): string => {
	if (minutes === null || !Number.isFinite(minutes) || minutes < 0) {
		return "--";
	}

	if (minutes >= 10) {
		return `${Math.round(minutes).toLocaleString("en-US")}m`;
	}

	if (minutes >= 1) {
		const rounded = Math.round(minutes * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}m`;
	}

	const fraction = minutes.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
	return `${fraction}m`;
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

interface TimelineRowWindow {
	startMs: number;
	endMs: number;
}

interface TimelineWindow {
	startMs: number;
	endMs: number;
	rangeMs: number;
}

interface TimelineLayout {
	contextWidth: number;
	trackWidth: number;
	viewportWidth: number;
	scrollLeft: number;
}

const trimTimelineSegmentsLeft = (
	segments: Array<{
		content: string;
		highlighted: boolean;
	}>,
	trimCount: number,
): Array<{
	content: string;
	highlighted: boolean;
}> => {
	if (trimCount <= 0) {
		return segments;
	}

	let remainingTrim = trimCount;
	const trimmedSegments: Array<{
		content: string;
		highlighted: boolean;
	}> = [];

	for (const segment of segments) {
		if (remainingTrim >= segment.content.length) {
			remainingTrim -= segment.content.length;
			continue;
		}

		if (remainingTrim > 0) {
			trimmedSegments.push({
				content: segment.content.slice(remainingTrim),
				highlighted: segment.highlighted,
			});
			remainingTrim = 0;
			continue;
		}

		trimmedSegments.push(segment);
	}

	return trimmedSegments;
};

const getTimelineRowWindow = (
	line: HierarchyLine,
): TimelineRowWindow | null => {
	const startMs = normalizeTimestamp(line.node.original.time_created);
	const updatedMs = normalizeTimestamp(line.node.original.time_updated);
	const fallbackTime = startMs ?? updatedMs;

	if (fallbackTime === null) {
		return null;
	}

	return {
		startMs: startMs ?? fallbackTime,
		endMs: Math.max(updatedMs ?? fallbackTime, startMs ?? fallbackTime),
	};
};

const getTimelineWindow = (lines: HierarchyLine[]): TimelineWindow | null => {
	let startMs = Number.POSITIVE_INFINITY;
	let endMs = Number.NEGATIVE_INFINITY;

	for (const line of lines) {
		const rowWindow = getTimelineRowWindow(line);
		if (!rowWindow) {
			continue;
		}

		startMs = Math.min(startMs, rowWindow.startMs);
		endMs = Math.max(endMs, rowWindow.endMs);
	}

	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		return null;
	}

	if (startMs === endMs) {
		endMs += 60_000;
	}

	return {
		startMs,
		endMs,
		rangeMs: Math.max(endMs - startMs, 1),
	};
};

export const getTimelineTrackWidth = (
	timelineViewportWidth?: number,
): number => {
	const viewportWidth = clampNumber(
		Math.floor(timelineViewportWidth ?? TIMELINE_TRACK_MIN_WIDTH),
		12,
		Number.MAX_SAFE_INTEGER,
	);

	if (viewportWidth >= TIMELINE_TRACK_MIN_WIDTH) {
		return viewportWidth;
	}

	const scrollPadding = Math.max(
		Math.floor(viewportWidth * TIMELINE_TRACK_SCROLL_PADDING_RATIO),
		TIMELINE_TRACK_SCROLL_PADDING_MIN,
	);

	return Math.max(TIMELINE_TRACK_MIN_WIDTH, viewportWidth) + scrollPadding;
};

const getTimelineLayout = (
	timelineViewportWidth?: number,
	timelineScrollLeft?: number,
	infoMode: HierarchyInfoMode = "standard",
	contextWidthOverride?: number,
): TimelineLayout => {
	const trackWidth = getTimelineTrackWidth(timelineViewportWidth);
	const contextWidth =
		contextWidthOverride ?? getTimelineContextWidth(infoMode);
	const viewportWidth = clampNumber(
		Math.floor(timelineViewportWidth ?? trackWidth),
		12,
		trackWidth,
	);
	const maxScrollLeft = Math.max(trackWidth - viewportWidth, 0);

	return {
		contextWidth,
		trackWidth,
		viewportWidth,
		scrollLeft: clampNumber(
			Math.floor(timelineScrollLeft ?? 0),
			0,
			maxScrollLeft,
		),
	};
};

const getTreeIndent = (line: HierarchyLine): TreeIndentMeta => {
	return line.indent as TreeIndentMeta;
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

const getTimelineContextWidthForLines = (
	renderedLines: HierarchyLine[],
	infoMode: HierarchyInfoMode = "standard",
	viewMode: HierarchyViewMode = "tree",
): number => {
	const baseContextWidth = getTimelineContextWidth(infoMode);
	if (viewMode !== "flow") {
		return baseContextWidth;
	}

	return renderedLines.reduce((maxWidth, line) => {
		return Math.max(maxWidth, getDetailPrefix(line).length);
	}, baseContextWidth);
};

const getLineRunningSubagentCount = (line: HierarchyLine): number => {
	if (!line.node.isRoot || !("subagentSessions" in line.node.original)) {
		return 0;
	}

	return countRunningSubagents(line.node.original);
};

const getLineStatusDisplay = (
	line: HierarchyLine,
): {
	label: string;
	colorStatus: SessionStatus;
} => {
	const runningSubagents = getLineRunningSubagentCount(line);

	return {
		label: getStatusLabel(line.standardInfo.status, {
			runningSubagents,
			finishReason: line.standardInfo.finishReason,
		}),
		colorStatus: getDisplayStatus(line.standardInfo.status, {
			runningSubagents,
			finishReason: line.standardInfo.finishReason,
		}),
	};
};

export const getHierarchyTimelineContextWidth = ({
	session,
	messageCountBySessionId,
	viewMode = "tree",
	infoMode = "standard",
	filterMode = "latest",
	narrowMode = false,
}: Pick<
	HierarchyViewContentProps,
	| "session"
	| "messageCountBySessionId"
	| "viewMode"
	| "infoMode"
	| "filterMode"
	| "narrowMode"
>): number => {
	const activeViewMode = narrowMode ? "tree" : viewMode;
	const lineBuildMode: HierarchyViewMode =
		activeViewMode === "flow" ? "tree" : activeViewMode;
	const preparedSession = session
		? getPreparedSession(session, filterMode)
		: null;
	const renderedLines = preparedSession
		? buildHierarchyLines(
				preparedSession,
				lineBuildMode,
				infoMode,
				messageCountBySessionId,
			)
		: [];

	return getTimelineContextWidthForLines(
		renderedLines,
		infoMode,
		activeViewMode,
	);
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

const getTimelineTrackEndMarker = (status: SessionStatus): string => {
	switch (status) {
		case SessionStatus.completed:
			return "●";
		case SessionStatus.failed:
			return "✕";
		case SessionStatus.running:
		case SessionStatus.waiting:
		case SessionStatus.pending:
			return "▶";
		default:
			return "◆";
	}
};

const getTimelineViewportEdgeMarker = (status: SessionStatus): string => {
	switch (status) {
		case SessionStatus.running:
		case SessionStatus.waiting:
		case SessionStatus.pending:
			return ">";
		default:
			return getTimelineTrackEndMarker(status);
	}
};

const buildTimelineTrackSegments = (params: {
	status: SessionStatus;
	activityStatus: SessionStatus;
	rowWindow: TimelineRowWindow | null;
	timelineWindow: TimelineWindow | null;
	layout: TimelineLayout;
}): Array<{
	content: string;
	highlighted: boolean;
}> => {
	const { status, activityStatus, rowWindow, timelineWindow, layout } = params;
	const fullTrack = Array.from({ length: layout.trackWidth }, () => "·");
	let trackStartIndex = 0;
	let trackEndIndex = -1;

	if (rowWindow && timelineWindow) {
		trackStartIndex = clampNumber(
			Math.round(
				((rowWindow.startMs - timelineWindow.startMs) /
					timelineWindow.rangeMs) *
					(layout.trackWidth - 1),
			),
			0,
			layout.trackWidth - 1,
		);
		trackEndIndex = clampNumber(
			Math.max(
				trackStartIndex,
				Math.round(
					((rowWindow.endMs - timelineWindow.startMs) /
						timelineWindow.rangeMs) *
						(layout.trackWidth - 1),
				),
			),
			0,
			layout.trackWidth - 1,
		);

		if (trackStartIndex === trackEndIndex) {
			fullTrack[trackStartIndex] = getTimelineTrackEndMarker(status);
		} else {
			fullTrack[trackStartIndex] = "╺";
			for (let index = trackStartIndex + 1; index < trackEndIndex; index += 1) {
				fullTrack[index] = "━";
			}
			fullTrack[trackEndIndex] = getTimelineTrackEndMarker(status);
		}
	}

	const visibleStart = layout.scrollLeft;
	const visibleEnd = visibleStart + layout.viewportWidth;
	const visibleChars = fullTrack
		.join("")
		.slice(visibleStart, visibleEnd)
		.split("");
	const colorStates = Array.from({ length: visibleChars.length }, () => false);

	if (!rowWindow || !timelineWindow || trackEndIndex < trackStartIndex) {
		return visibleChars.length > 0
			? [{ content: visibleChars.join(""), highlighted: false }]
			: [];
	}

	const visibleEndWithinTrack = visibleStart + visibleChars.length;
	const highlightedStart = Math.max(trackStartIndex, visibleStart);
	const highlightedEnd = Math.min(trackEndIndex + 1, visibleEndWithinTrack);

	if (highlightedStart < highlightedEnd) {
		const localStart = highlightedStart - visibleStart;
		const localEnd = highlightedEnd - visibleStart;

		for (let index = localStart; index < localEnd; index += 1) {
			colorStates[index] = true;
		}
	}

	if (isActiveStatus(activityStatus) && visibleChars.length > 0) {
		const edgeIndex =
			highlightedStart >= highlightedEnd
				? trackStartIndex < visibleStart
					? 0
					: visibleChars.length - 1
				: visibleChars.length - 1;

		visibleChars[edgeIndex] = getTimelineViewportEdgeMarker(activityStatus);
		colorStates[edgeIndex] = true;
	}

	const segments: Array<{ content: string; highlighted: boolean }> = [];
	let currentHighlight: boolean | null = null;
	let buffer = "";

	for (let index = 0; index < visibleChars.length; index += 1) {
		const highlighted = colorStates[index] ?? false;
		const char = visibleChars[index] ?? "";

		if (currentHighlight === null) {
			currentHighlight = highlighted;
			buffer = char;
			continue;
		}

		if (currentHighlight === highlighted) {
			buffer += char;
			continue;
		}

		segments.push({
			content: buffer,
			highlighted: currentHighlight,
		});
		currentHighlight = highlighted;
		buffer = char;
	}

	if (buffer.length > 0 && currentHighlight !== null) {
		segments.push({
			content: buffer,
			highlighted: currentHighlight,
		});
	}

	return segments;
};

const buildTimelineAxisSlice = (layout: TimelineLayout): string => {
	const axis = Array.from({ length: layout.trackWidth }, (_, index) => {
		if (index === 0 || index === layout.trackWidth - 1) {
			return "│";
		}

		return index % TIMELINE_AXIS_INTERVAL === 0 ? "┼" : "─";
	}).join("");

	return axis.slice(
		layout.scrollLeft,
		layout.scrollLeft + layout.viewportWidth,
	);
};

const buildTimelineTickLabelSlice = (
	layout: TimelineLayout,
	timelineWindow: TimelineWindow | null,
): string => {
	const labelBuffer = Array.from({ length: layout.viewportWidth }, () => " ");

	if (!timelineWindow) {
		return labelBuffer.join("");
	}

	const maxTrackIndex = Math.max(layout.trackWidth - 1, 1);
	const totalMinutes = timelineWindow.rangeMs / 60_000;
	const tickIndexes: number[] = [];

	for (let index = 0; index <= maxTrackIndex; index += TIMELINE_AXIS_INTERVAL) {
		tickIndexes.push(index);
	}

	if (tickIndexes[tickIndexes.length - 1] !== maxTrackIndex) {
		tickIndexes.push(maxTrackIndex);
	}

	for (const tickIndex of tickIndexes) {
		const localTickIndex = tickIndex - layout.scrollLeft;
		if (localTickIndex < 0 || localTickIndex >= layout.viewportWidth) {
			continue;
		}

		const elapsedMinutes = (tickIndex / maxTrackIndex) * totalMinutes;
		const label = formatTimelineMinutes(elapsedMinutes);
		if (label === "--") {
			continue;
		}

		const centeredStart = localTickIndex - Math.floor(label.length / 2);
		const maxStart = Math.max(layout.viewportWidth - label.length, 0);
		const startIndex = clampNumber(centeredStart, 0, maxStart);

		for (let offset = 0; offset < label.length; offset += 1) {
			const bufferIndex = startIndex + offset;
			if (bufferIndex >= 0 && bufferIndex < labelBuffer.length) {
				labelBuffer[bufferIndex] = label[offset] ?? " ";
			}
		}
	}

	return labelBuffer.join("");
};

interface TimelineAxisData {
	axisSlice: string;
	tickLabelSlice: string;
	startOffsetLabel: string;
	endOffsetLabel: string;
	tickMinutesLabel: string;
	windowSpan: string;
	contextSpacer: string;
}

const getTimelineAxisData = (
	lines: HierarchyLine[],
	layout: TimelineLayout,
): TimelineAxisData => {
	const rootDetailPrefix = lines.length > 0 ? getDetailPrefix(lines[0]) : "";
	const axisInsetWidth =
		rootDetailPrefix.length > 0 ? rootDetailPrefix.length : layout.contextWidth;
	const timelineWindow = getTimelineWindow(lines);
	const totalMinutes = timelineWindow ? timelineWindow.rangeMs / 60_000 : null;
	const tickMinutes = timelineWindow
		? ((timelineWindow.rangeMs / Math.max(layout.trackWidth - 1, 1)) *
				TIMELINE_AXIS_INTERVAL) /
			60_000
		: null;

	return {
		axisSlice: buildTimelineAxisSlice(layout),
		tickLabelSlice: buildTimelineTickLabelSlice(layout, timelineWindow),
		startOffsetLabel: "0",
		endOffsetLabel: formatTimelineMinutes(totalMinutes),
		tickMinutesLabel: formatTimelineMinutes(tickMinutes),
		windowSpan: timelineWindow
			? formatDuration(timelineWindow.startMs, timelineWindow.endMs)
			: "--",
		contextSpacer: " ".repeat(axisInsetWidth),
	};
};

const createTimelineIntroText = (): ReturnType<typeof Text> => {
	return Text({
		content: t`${fg(VIEW_COLORS.flowAccent)("timeline")} ${dim(TIMELINE_INTRO_TEXT)}`,
		fg: VIEW_COLORS.muted,
		width: "100%",
		wrapMode: "word",
	});
};

const createTimelineAxisText = (
	axisData: TimelineAxisData,
): ReturnType<typeof Text> => {
	return Text({
		content: t`${axisData.contextSpacer}${fg(VIEW_COLORS.muted)(axisData.axisSlice)}`,
		fg: VIEW_COLORS.muted,
		width: "100%",
		wrapMode: "none",
	});
};

const createTimelineGuideText = (
	axisData: TimelineAxisData,
): ReturnType<typeof Text> => {
	return Text({
		content: t`${axisData.contextSpacer}${dim("start ")}${axisData.startOffsetLabel}${dim("  end ")}${axisData.endOffsetLabel}${dim("  tick ")}${axisData.tickMinutesLabel}${dim(" /mark  span ")}${axisData.windowSpan}`,
		fg: VIEW_COLORS.muted,
		width: "100%",
		wrapMode: "none",
	});
};

const createTimelineTickLabelText = (
	axisData: TimelineAxisData,
): ReturnType<typeof Text> => {
	return Text({
		content: t`${axisData.contextSpacer}${fg(VIEW_COLORS.muted)(axisData.tickLabelSlice)}`,
		fg: VIEW_COLORS.muted,
		width: "100%",
		wrapMode: "none",
	});
};

const renderTreeHierarchyLine = (
	line: HierarchyLine,
	options: { showSpacer?: boolean; onCopyId?: (id: string) => void } = {},
) => {
	const info = line.standardInfo;
	const agentName = getSessionAgentDisplayName(info.agent, {
		isRoot: line.node.isRoot,
	});
	const modelLabel = getModelLabel(info.modelID, info.variant);
	const statusDisplay = getLineStatusDisplay(line);
	const statusColor = STATUS_COLOR_MAP[statusDisplay.colorStatus];
	const titleColor = line.node.isRoot ? VIEW_COLORS.accent : VIEW_COLORS.text;
	const title = normalizeInlineText(line.node.title, "Untitled");
	const detailPrefix = getDetailPrefix(line);
	const showSpacer = options.showSpacer ?? false;
	const titleContent = t`${fg(VIEW_COLORS.muted)(getLinePrefix(line))}${bold(fg(titleColor)(title))}`;
	const metadataContent = t`${fg(VIEW_COLORS.muted)(detailPrefix)}${dim("status ")}${fg(statusColor)(statusDisplay.label)}${dim("  agent ")}${fg(getAgentColor(info.agent))(agentName)}${modelLabel ? dim(" / ") : ""}${modelLabel ? fg(VIEW_COLORS.muted)(modelLabel) : ""}`;

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
						content: t`${fg(VIEW_COLORS.muted)(detailPrefix)}${dim("id ")}${line.detailedInfo.id}${dim("  created ")}${formatRelativeTime(line.detailedInfo.timeCreated)}${dim("  updated ")}${formatRelativeTime(line.detailedInfo.timeUpdated)}`,
						fg: VIEW_COLORS.muted,
						width: "100%",
						wrapMode: "word",
						onMouseDown: (event) => {
							if (event.button !== MouseButton.LEFT || event.isDragging) {
								return;
							}
							const id = line.detailedInfo?.id;
							if (id) {
								options.onCopyId?.(id);
							}
						},
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

const getTimelinePrimarySegmentWidths = (
	availableWidth: number,
	agentLabelLength: number,
): {
	agentWidth: number;
	titleWidth: number;
} => {
	const clampedAvailableWidth = Math.max(Math.floor(availableWidth), 2);
	const minTitleWidth = Math.min(8, Math.max(clampedAvailableWidth - 1, 1));
	const minAgentWidth = Math.min(4, Math.max(clampedAvailableWidth - 1, 1));

	let agentWidth = Math.min(
		agentLabelLength,
		Math.max(Math.floor(clampedAvailableWidth * 0.35), 1),
	);
	let titleWidth = Math.max(clampedAvailableWidth - agentWidth, 1);

	if (titleWidth < minTitleWidth && agentWidth > 1) {
		const shiftToTitle = Math.min(minTitleWidth - titleWidth, agentWidth - 1);
		titleWidth += shiftToTitle;
		agentWidth -= shiftToTitle;
	}

	if (agentWidth < minAgentWidth && titleWidth > 1) {
		const shiftToAgent = Math.min(minAgentWidth - agentWidth, titleWidth - 1);
		agentWidth += shiftToAgent;
		titleWidth -= shiftToAgent;
	}

	return {
		agentWidth,
		titleWidth,
	};
};

const renderTimelineHierarchyLine = (
	line: HierarchyLine,
	params: {
		layout: TimelineLayout;
		timelineWindow: TimelineWindow | null;
		baseDetailPrefixWidth: number;
		showSpacer?: boolean;
	},
) => {
	const info = line.standardInfo;
	const isDetailedMode = line.infoMode === "detailed";
	const showSpacer = params.showSpacer ?? false;
	const agentName = getSessionAgentDisplayName(info.agent, {
		isRoot: line.node.isRoot,
	});
	const modelLabel = getModelLabel(info.modelID, info.variant);
	const statusDisplay = getLineStatusDisplay(line);
	const statusColor = TIMELINE_STATUS_COLOR_MAP[statusDisplay.colorStatus];
	const titleColor = line.node.isRoot
		? VIEW_COLORS.flowAccent
		: VIEW_COLORS.text;
	const linePrefix = getLinePrefix(line);
	const detailPrefix = getDetailPrefix(line);
	const rowWindow = getTimelineRowWindow(line);
	const spanLabel = formatDuration(rowWindow?.startMs, rowWindow?.endMs);
	const normalizedTitle = normalizeInlineText(line.node.title, "Untitled");
	const primaryRowWidth = Math.max(
		params.layout.viewportWidth +
			params.layout.contextWidth -
			Math.max(linePrefix.length - params.layout.contextWidth, 0),
		12,
	);
	const primarySegmentWidth = Math.max(
		primaryRowWidth - linePrefix.length - spanLabel.length - 6,
		2,
	);
	const { agentWidth, titleWidth } = getTimelinePrimarySegmentWidths(
		primarySegmentWidth,
		agentName.length,
	);
	const primaryAgentLabel = truncateLabelEnd(agentName, agentWidth);
	const primaryTitleLabel = truncateLabelStart(normalizedTitle, titleWidth);
	const trackSegments = buildTimelineTrackSegments({
		status: statusDisplay.colorStatus,
		activityStatus: line.standardInfo.status,
		rowWindow,
		timelineWindow: params.timelineWindow,
		layout: params.layout,
	});
	const trimmedTrackSegments = trimTimelineSegmentsLeft(
		trackSegments,
		Math.max(detailPrefix.length - params.baseDetailPrefixWidth, 0),
	);
	const standardPrimaryContent = t`${fg(VIEW_COLORS.muted)(linePrefix)}${fg(getAgentColor(info.agent))(primaryAgentLabel)}${dim(" : ")}${bold(fg(titleColor)(primaryTitleLabel))}${dim(" (")}${fg(statusColor)(spanLabel)}${dim(")")}`;
	const standardTimelineContent = new StyledText([
		fg(VIEW_COLORS.muted)(detailPrefix),
		...trimmedTrackSegments.map((segment) =>
			segment.highlighted
				? fg(statusColor)(segment.content)
				: fg(VIEW_COLORS.muted)(segment.content),
		),
	]);
	const detailedAdditionalContent = t`${fg(VIEW_COLORS.muted)(detailPrefix)}${dim("status ")}${fg(statusColor)(statusDisplay.label)}${dim("  started ")}${formatRelativeTime(rowWindow?.startMs)}${dim("  updated ")}${formatRelativeTime(rowWindow?.endMs)}${modelLabel ? dim("  model ") : ""}${modelLabel ? fg(VIEW_COLORS.muted)(modelLabel) : ""}${line.detailedInfo ? dim("  msgs ") : ""}${line.detailedInfo ? formatMessageCount(line.detailedInfo.messageCount) : ""}${line.detailedInfo ? dim("  children ") : ""}${line.detailedInfo ? formatSubagentCount(line.detailedInfo.subagentCount) : ""}`;

	return Box(
		{
			width: "100%",
			flexDirection: "column",
			marginBottom: 0,
		},
		Text({
			content: standardPrimaryContent,
			width: "100%",
			wrapMode: "none",
			truncate: true,
		}),
		...(isDetailedMode
			? [
					Text({
						content: detailedAdditionalContent,
						width: "100%",
						wrapMode: "none",
						truncate: true,
					}),
				]
			: []),
		Text({
			content: standardTimelineContent,
			width: "100%",
			wrapMode: "none",
		}),
		...(isDetailedMode && showSpacer
			? [
					Text({
						content: t`${fg(VIEW_COLORS.muted)(detailPrefix)}`,
						width: "100%",
					}),
				]
			: []),
	);
};

const renderTimelineHierarchy = (
	lines: HierarchyLine[],
	params: {
		layout: TimelineLayout;
		showAxisLine?: boolean;
		showIntroLine?: boolean;
	},
): HierarchyViewChild[] => {
	const timelineWindow = getTimelineWindow(lines);
	const showAxisLine = params.showAxisLine ?? true;
	const showIntroLine = params.showIntroLine ?? true;
	const axisData = getTimelineAxisData(lines, params.layout);
	const baseDetailPrefixWidth =
		lines.length > 0 ? getDetailPrefix(lines[0]).length : 0;
	const children: HierarchyViewChild[] = [];

	if (showIntroLine) {
		children.push(createTimelineIntroText());
	}

	if (showAxisLine) {
		children.push(createTimelineGuideText(axisData));
		children.push(createTimelineAxisText(axisData));
		children.push(createTimelineTickLabelText(axisData));
	}

	children.push(Box({ height: 1 }));

	for (const [index, line] of lines.entries()) {
		children.push(
			renderTimelineHierarchyLine(line, {
				layout: params.layout,
				timelineWindow,
				baseDetailPrefixWidth,
				showSpacer: line.infoMode === "detailed" && index < lines.length - 1,
			}),
		);
	}

	return children;
};

export const createHierarchyTimelineAnchor = ({
	session,
	viewMode = "tree",
	infoMode = "standard",
	filterMode = "latest",
	timelineScrollLeft = 0,
	timelineViewportWidth,
	narrowMode = false,
}: HierarchyTimelineAnchorProps): ReturnType<typeof Box> | null => {
	const activeViewMode = narrowMode ? "tree" : viewMode;
	if (activeViewMode !== "flow" || !session) {
		return null;
	}

	const preparedSession = getPreparedSession(session, filterMode);
	const lines = buildHierarchyLines(preparedSession, "tree", "standard");
	const layout = getTimelineLayout(
		timelineViewportWidth,
		timelineScrollLeft,
		infoMode,
	);
	const axisData = getTimelineAxisData(lines, layout);

	return Box(
		{
			width: "100%",
			flexDirection: "column",
		},
		createTimelineIntroText(),
		createTimelineGuideText(axisData),
		createTimelineAxisText(axisData),
		createTimelineTickLabelText(axisData),
	);
};

export const createHierarchyViewContent = ({
	session,
	messageCountBySessionId,
	viewMode = "tree",
	infoMode = "standard",
	filterMode = "latest",
	timelineScrollLeft = 0,
	timelineViewportWidth,
	width = "100%",
	narrowMode = false,
	timelineAxisAnchored = false,
	sectionMode = "all",
	onCopyId,
}: HierarchyViewContentProps): ReturnType<typeof Box> => {
	const activeViewMode = narrowMode ? "tree" : viewMode;
	const lineBuildMode: HierarchyViewMode =
		activeViewMode === "flow" ? "tree" : activeViewMode;
	const preparedSession = session
		? getPreparedSession(session, filterMode)
		: null;
	const totalSubagentCount = session?.subagentSessions?.length ?? 0;
	const renderedLines = preparedSession
		? buildHierarchyLines(
				preparedSession,
				lineBuildMode,
				infoMode,
				messageCountBySessionId,
			)
		: [];
	const visibleSubagentCount =
		renderedLines.length > 0 ? renderedLines.length - 1 : 0;
	const summary = preparedSession
		? getSubagentSummary(preparedSession)
		: { total: 0, active: 0, running: 0, terminal: 0 };
	const sessionTitle = normalizeInlineText(
		preparedSession?.title,
		"No session selected",
	);
	const sessionStatus = preparedSession?.status ?? SessionStatus.unknown;
	const sessionDisplayStatus = getDisplayStatus(sessionStatus, {
		runningSubagents: summary.running,
		finishReason: preparedSession?.finishReason,
	});
	const sessionStatusLabel = getStatusLabel(sessionStatus, {
		runningSubagents: summary.running,
		finishReason: preparedSession?.finishReason,
	});
	const currentAgentName = preparedSession
		? getSessionAgentDisplayName(preparedSession.currentAgent, { isRoot: true })
		: "Unknown";
	const timelineLayout = getTimelineLayout(
		timelineViewportWidth,
		timelineScrollLeft,
		infoMode,
		getTimelineContextWidthForLines(renderedLines, infoMode, activeViewMode),
	);
	const headerSection = Section(
		"Agent Hierarchy",
		Text({
			content: t`${bold(fg(VIEW_COLORS.text)(narrowMode ? truncateLabelStart(sessionTitle, 40) : sessionTitle))}`,
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
			truncate: true,
		}),
		...(preparedSession
			? [
					Box(
						{
							width: "100%",
							flexDirection: "row",
							flexWrap: "wrap",
						},
						Badge(sessionStatusLabel, STATUS_COLOR_MAP[sessionDisplayStatus]),
						Badge(
							getSessionSourceLabel(preparedSession.sessionSource),
							getSessionSourceColor(preparedSession.sessionSource),
						),
						Badge(
							formatAgentBadgeLabel(
								currentAgentName,
								preparedSession.currentModelID,
								preparedSession.currentVariant,
							),
							getAgentColor(preparedSession.currentAgent),
						),
						...(preparedSession.currentReasoningEffort
							? [
									Badge(
										`Reasoning ${preparedSession.currentReasoningEffort}`,
										VIEW_COLORS.flowAccent,
									),
								]
							: []),
					),
				]
			: []),
	);

	const bodySection = Section(
		activeViewMode === "flow" ? "Timeline" : "Tree",
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
				? renderTimelineHierarchy(renderedLines, {
						layout: timelineLayout,
						showAxisLine: !timelineAxisAnchored,
						showIntroLine: !timelineAxisAnchored,
					})
				: renderedLines.map((line, index) =>
						renderTreeHierarchyLine(line, {
							showSpacer: index < renderedLines.length - 1,
							onCopyId,
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
	);

	const sections: HierarchyViewChild[] = [];

	if (sectionMode === "all" || sectionMode === "header") {
		sections.push(headerSection);
	}

	if (sectionMode === "all" || sectionMode === "body") {
		sections.push(bodySection);
	}

	return Box(
		{
			width,
			flexDirection: "column",
		},
		...sections,
	);
};
