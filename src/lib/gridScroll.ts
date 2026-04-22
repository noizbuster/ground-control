import { SESSION_CARD_MAX_HEIGHT } from "../ui/SessionCard";
import {
	SESSION_GRID_ROW_GAP,
	SESSION_GRID_VIEWPORT_VERTICAL_INSET,
} from "../ui/SessionGrid";

export const getGridVisibleRowCount = (gridHeight: number): number => {
	const viewportHeight = Math.max(
		gridHeight - SESSION_GRID_VIEWPORT_VERTICAL_INSET,
		1,
	);
	const rowStride = SESSION_CARD_MAX_HEIGHT + SESSION_GRID_ROW_GAP;

	return Math.max(
		1,
		Math.floor((viewportHeight + SESSION_GRID_ROW_GAP) / rowStride),
	);
};

export const getMaxGridScrollTop = (params: {
	gridHeight: number;
	columnCount: number;
	sessionCount: number;
}): number => {
	const { gridHeight, columnCount, sessionCount } = params;
	if (sessionCount <= 0) {
		return 0;
	}

	const safeColumnCount = Math.max(1, Math.floor(columnCount));
	const rowStride = SESSION_CARD_MAX_HEIGHT + SESSION_GRID_ROW_GAP;
	const totalRowCount = Math.ceil(sessionCount / safeColumnCount);
	const visibleRowCount = getGridVisibleRowCount(gridHeight);
	const hiddenRowCount = Math.max(totalRowCount - visibleRowCount, 0);

	return hiddenRowCount * rowStride;
};

export const clampGridScrollTop = (params: {
	currentScrollTop: number;
	gridHeight: number;
	columnCount: number;
	sessionCount: number;
}): number => {
	const { currentScrollTop, gridHeight, columnCount, sessionCount } = params;
	const maxGridScrollTop = getMaxGridScrollTop({
		gridHeight,
		columnCount,
		sessionCount,
	});

	return Math.min(Math.max(currentScrollTop, 0), maxGridScrollTop);
};
