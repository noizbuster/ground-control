import { describe, expect, it } from "vitest";
import {
	clampGridScrollTop,
	getMaxGridScrollTop,
	getGridVisibleRowCount,
} from "../src/lib/gridScroll";

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
