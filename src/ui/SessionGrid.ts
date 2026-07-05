import { Box, dim, ScrollBox, Text, t } from "@opentui/core";
import { getGridVisibleRowCount } from "../lib/gridScroll";
import type { Session } from "../types";
import { SessionStatus } from "../types";
import { SESSION_CARD_MAX_HEIGHT, SessionCard } from "./SessionCard";

type GridSize = number | `${number}%` | "100%";

export interface SessionGridProps {
	sessions: Session[];
	selectedIndex?: number;
	isFocusedPane?: boolean;
	statusBySessionId?: Partial<Record<string, SessionStatus>>;
	scrollBoxId?: string;
	onSelectSession?: (sessionId: string) => void;
	width?: GridSize;
	height?: GridSize;
}

export interface SessionGridContentProps {
	sessions: Session[];
	selectedIndex?: number;
	isFocusedPane?: boolean;
	statusBySessionId?: Partial<Record<string, SessionStatus>>;
	onSelectSession?: (sessionId: string) => void;
	width?: GridSize;
	scrollTop?: number;
	viewportHeight?: number;
}

const GRID_COLORS = {
	border: "#334155",
	surface: "#020617",
	empty: "#94A3B8",
	muted: "#64748B",
} as const;

const MIN_CARD_WIDTH = 30;
const DEFAULT_CARD_WIDTH = 38;
const MAX_COLUMNS = 4;
const GRID_COLUMN_GAP = 1;
const GRID_ROW_GAP = 0;
const GRID_HORIZONTAL_INSET = 3;
export const SESSION_GRID_ROW_GAP = GRID_ROW_GAP;
export const SESSION_GRID_VIEWPORT_VERTICAL_INSET = 4;

const isFiniteNumber = (value: GridSize | undefined): value is number => {
	return typeof value === "number" && Number.isFinite(value);
};

export const getGridColumnCount = (width?: GridSize): number => {
	if (!isFiniteNumber(width)) {
		return 1;
	}

	const availableWidth = Math.max(
		width - GRID_HORIZONTAL_INSET,
		MIN_CARD_WIDTH,
	);

	return Math.max(
		1,
		Math.min(
			MAX_COLUMNS,
			Math.floor(
				(availableWidth + GRID_COLUMN_GAP) / (MIN_CARD_WIDTH + GRID_COLUMN_GAP),
			),
		),
	);
};

const getCardWidth = (width?: GridSize): number => {
	if (!isFiniteNumber(width)) {
		return DEFAULT_CARD_WIDTH;
	}

	const availableWidth = Math.max(
		width - GRID_HORIZONTAL_INSET,
		MIN_CARD_WIDTH,
	);
	const columnCount = getGridColumnCount(width);

	return Math.max(
		MIN_CARD_WIDTH,
		Math.floor(
			(availableWidth - GRID_COLUMN_GAP * (columnCount - 1)) / columnCount,
		),
	);
};

const getSessionStatus = (
	session: Session,
	statusBySessionId?: Partial<Record<string, SessionStatus>>,
): SessionStatus | undefined => {
	return statusBySessionId?.[session.id] ?? session.status;
};

const EmptyState = () => {
	return Box(
		{
			width: "100%",
			flexDirection: "column",
		},
		Text({
			content: t`${dim("No active sessions")}`,
			fg: GRID_COLORS.empty,
		}),
		Box({ height: 1 }),
		Text({
			content: "Waiting for the monitor to discover sessions.",
			fg: GRID_COLORS.muted,
		}),
	);
};

const VIRTUAL_BUFFER_ROWS = 2;
const SCROLL_ROW_STRIDE = SESSION_CARD_MAX_HEIGHT + GRID_ROW_GAP;

export const createSessionGridContent = ({
	sessions,
	selectedIndex = -1,
	isFocusedPane = true,
	statusBySessionId,
	onSelectSession,
	width = "100%",
	scrollTop = 0,
	viewportHeight = 0,
}: SessionGridContentProps) => {
	const cardWidth = getCardWidth(width);

	if (sessions.length === 0) {
		return EmptyState();
	}

	const columnCount = Math.max(1, getGridColumnCount(width));
	const totalRows = Math.ceil(sessions.length / columnCount);

	// Virtualization: only render sessions in the visible scroll window.
	// When viewportHeight is 0 (first render / unknown), render all.
	if (viewportHeight > 0) {
		const firstRow = Math.max(
			0,
			Math.floor(scrollTop / SCROLL_ROW_STRIDE) - VIRTUAL_BUFFER_ROWS,
		);
		const visibleRowCount =
			getGridVisibleRowCount(viewportHeight) + VIRTUAL_BUFFER_ROWS * 2;
		const lastRow = Math.min(totalRows, firstRow + visibleRowCount);

		const firstIndex = firstRow * columnCount;
		const lastIndex = Math.min(sessions.length, lastRow * columnCount);
		const visibleSessions = sessions.slice(firstIndex, lastIndex);

		const topSpacerHeight = firstRow * SCROLL_ROW_STRIDE;
		const bottomSpacerHeight = (totalRows - lastRow) * SCROLL_ROW_STRIDE;

		return Box(
			{
				width: "100%",
				flexDirection: "column",
			},
			...(topSpacerHeight > 0 ? [Box({ height: topSpacerHeight })] : []),
			Box(
				{
					width: "100%",
					flexDirection: "row",
					flexWrap: "wrap",
					rowGap: GRID_ROW_GAP,
					columnGap: GRID_COLUMN_GAP,
				},
				...visibleSessions.map((session, relativeIndex) => {
					const absoluteIndex = firstIndex + relativeIndex;
					return SessionCard({
						session,
						status: getSessionStatus(session, statusBySessionId),
						isSelected: absoluteIndex === selectedIndex,
						isActivePane: isFocusedPane,
						isWaiting:
							getSessionStatus(session, statusBySessionId) ===
							SessionStatus.waiting,
						width: cardWidth,
						onSelect: onSelectSession,
					});
				}),
			),
			...(bottomSpacerHeight > 0
				? [Box({ height: bottomSpacerHeight })]
				: []),
		);
	}

	// No viewport info: render all sessions (used on first render).
	return Box(
		{
			width: "100%",
			flexDirection: "row",
			flexWrap: "wrap",
			rowGap: GRID_ROW_GAP,
			columnGap: GRID_COLUMN_GAP,
		},
		...sessions.map((session, index) =>
			SessionCard({
				session,
				status: getSessionStatus(session, statusBySessionId),
				isSelected: index === selectedIndex,
				isActivePane: isFocusedPane,
				isWaiting:
					getSessionStatus(session, statusBySessionId) ===
					SessionStatus.waiting,
				width: cardWidth,
				onSelect: onSelectSession,
			}),
		),
	);
};

export const SessionGrid = ({
	sessions,
	selectedIndex = -1,
	isFocusedPane = true,
	statusBySessionId,
	scrollBoxId,
	onSelectSession,
	width = "100%",
	height = "100%",
}: SessionGridProps) => {
	return ScrollBox(
		{
			id: scrollBoxId,
			width,
			height,
			border: true,
			borderColor: GRID_COLORS.border,
			backgroundColor: GRID_COLORS.surface,
			paddingTop: 1,
			paddingBottom: 1,
			paddingLeft: 1,
			paddingRight: 0,
		},
		createSessionGridContent({
			sessions,
			selectedIndex,
			isFocusedPane,
			statusBySessionId,
			onSelectSession,
			width,
		}),
	);
};

export default SessionGrid;
