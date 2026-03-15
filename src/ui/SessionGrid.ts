import { Box, dim, ScrollBox, Text, t } from "@opentui/core";
import type { Session } from "../types";
import { SessionStatus } from "../types";
import { SessionCard } from "./SessionCard";

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
const GRID_GAP = 1;
const GRID_HORIZONTAL_INSET = 4;
export const SESSION_GRID_ROW_GAP = GRID_GAP;
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
			Math.floor((availableWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)),
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
		Math.floor((availableWidth - GRID_GAP * (columnCount - 1)) / columnCount),
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

export const createSessionGridContent = ({
	sessions,
	selectedIndex = -1,
	isFocusedPane = true,
	statusBySessionId,
	onSelectSession,
	width = "100%",
}: SessionGridContentProps) => {
	const cardWidth = getCardWidth(width);

	return sessions.length === 0
		? EmptyState()
		: Box(
				{
					width: "100%",
					flexDirection: "row",
					flexWrap: "wrap",
					gap: GRID_GAP,
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
			padding: 1,
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
