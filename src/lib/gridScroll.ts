import { isRenderable, type Renderable } from "@opentui/core";
import type { Session } from "../types";
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

export const clampSelection = (
	sessions: Session[],
	selectedIndex: number,
): number => {
	if (sessions.length === 0) {
		return -1;
	}

	if (selectedIndex < 0) {
		return 0;
	}

	if (selectedIndex >= sessions.length) {
		return sessions.length - 1;
	}

	return selectedIndex;
};

const isVisibleRenderable = (
	node: Renderable | undefined,
): node is Renderable => isRenderable(node) && node.visible === true;

// After grid virtualization (fd1784e) the grid content holds an outer column
// wrapper that may flank the card row container with top/bottom spacers. The
// card row is the first descendant whose visible children share a Y position
// (i.e. form a row). Descend through wrapper/spacer boxes to reach it.
export const getRenderedGridColumnCount = (
	gridContentRenderable: Renderable | undefined,
	fallbackColumnCount: number,
): number => {
	if (
		typeof gridContentRenderable !== "object" ||
		gridContentRenderable === null ||
		!("backgroundColor" in gridContentRenderable)
	) {
		return Math.max(1, fallbackColumnCount);
	}

	let current: Renderable = gridContentRenderable;
	for (let depth = 0; depth < 4; depth += 1) {
		const visibleChildren = current.getChildren().filter(isVisibleRenderable);
		if (visibleChildren.length === 0) {
			return Math.max(1, fallbackColumnCount);
		}

		const firstRowY = visibleChildren[0].y;
		const sameRowChildren = visibleChildren.filter(
			(child) => child.y === firstRowY,
		);

		if (sameRowChildren.length >= 2) {
			return sameRowChildren.length;
		}

		const next = visibleChildren.find(
			(child) =>
				"backgroundColor" in child &&
				child.getChildren().some(isVisibleRenderable),
		);
		if (!next) {
			return Math.max(1, sameRowChildren.length);
		}
		current = next;
	}

	return Math.max(1, fallbackColumnCount);
};

export const moveSelectionInGrid = (params: {
	sessions: Session[];
	selectedIndex: number;
	columnCount: number;
	direction: "left" | "right" | "up" | "down";
}): number => {
	const { sessions, selectedIndex, columnCount, direction } = params;

	if (sessions.length === 0) {
		return -1;
	}

	const currentIndex = clampSelection(sessions, selectedIndex);
	const safeColumnCount = Math.max(1, Math.floor(columnCount));

	switch (direction) {
		case "left":
			return Math.max(0, currentIndex - 1);
		case "right":
			return Math.min(sessions.length - 1, currentIndex + 1);
		case "up":
			return currentIndex < safeColumnCount
				? currentIndex
				: currentIndex - safeColumnCount;
		case "down": {
			const nextIndex = currentIndex + safeColumnCount;
			if (nextIndex < sessions.length) {
				return nextIndex;
			}

			const currentColumn = currentIndex % safeColumnCount;
			const lastRowStart = Math.max(
				Math.floor((sessions.length - 1) / safeColumnCount) * safeColumnCount,
				0,
			);
			return Math.min(lastRowStart + currentColumn, sessions.length - 1);
		}
	}
};
