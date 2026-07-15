import { describe, expect, it } from "vitest";
import {
	clampGridScrollTop,
	getGridVisibleRowCount,
	getMaxGridScrollTop,
	moveSelectionByPageInGrid,
} from "../src/lib/gridScroll";
import { type Session, SessionStatus } from "../src/types";

const makeSessions = (count: number): Session[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `session-${index}`,
		title: `Session ${index}`,
		directory: "/tmp",
		project_id: "/tmp",
		project_label: "tmp",
		parent_id: null,
		time_created: index,
		time_updated: index,
		sessionSource: "opencode",
		status: SessionStatus.running,
	}));

describe("gridScroll helpers", () => {
	it("returns zero max scroll when all sessions fit in the viewport", () => {
		expect(
			getMaxGridScrollTop({
				gridHeight: 40,
				columnCount: 1,
				sessionCount: 2,
			}),
		).toBe(0);
	});

	it("clamps stale scroll positions when the session list shrinks", () => {
		const gridHeight = 40;
		const columnCount = 1;
		const sessionCount = 1;

		expect(getGridVisibleRowCount(gridHeight)).toBeGreaterThanOrEqual(1);
		expect(
			clampGridScrollTop({
				currentScrollTop: 10_000,
				gridHeight,
				columnCount,
				sessionCount,
			}),
		).toBe(0);
	});

	it("preserves in-range scroll positions", () => {
		const gridHeight = 22;
		const columnCount = 1;
		const sessionCount = 8;
		const maxGridScrollTop = getMaxGridScrollTop({
			gridHeight,
			columnCount,
			sessionCount,
		});

		expect(maxGridScrollTop).toBeGreaterThan(0);
		expect(
			clampGridScrollTop({
				currentScrollTop: maxGridScrollTop - 1,
				gridHeight,
				columnCount,
				sessionCount,
			}),
		).toBe(maxGridScrollTop - 1);
	});
});

describe("moveSelectionByPageInGrid", () => {
	it("moves selection down by one visible page of rows", () => {
		const sessions = makeSessions(20);
		expect(
			moveSelectionByPageInGrid({
				sessions,
				selectedIndex: 0,
				columnCount: 2,
				visibleRowCount: 3,
				direction: "down",
			}),
		).toBe(6);
	});

	it("moves selection up by one visible page of rows", () => {
		const sessions = makeSessions(20);
		expect(
			moveSelectionByPageInGrid({
				sessions,
				selectedIndex: 10,
				columnCount: 2,
				visibleRowCount: 3,
				direction: "up",
			}),
		).toBe(4);
	});

	it("clamps to the first and last session", () => {
		const sessions = makeSessions(5);
		expect(
			moveSelectionByPageInGrid({
				sessions,
				selectedIndex: 1,
				columnCount: 1,
				visibleRowCount: 10,
				direction: "up",
			}),
		).toBe(0);
		expect(
			moveSelectionByPageInGrid({
				sessions,
				selectedIndex: 1,
				columnCount: 1,
				visibleRowCount: 10,
				direction: "down",
			}),
		).toBe(4);
	});
});
