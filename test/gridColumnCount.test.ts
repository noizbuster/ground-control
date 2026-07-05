import { describe, expect, it } from "vitest";
import type { Renderable } from "@opentui/core";
import { getRenderedGridColumnCount } from "../src/lib/gridScroll";

const RENDERABLE_BRAND = Symbol.for("@opentui/core/Renderable");

interface MockRenderable {
	[RENDERABLE_BRAND]: true;
	backgroundColor: string;
	y: number;
	visible: boolean;
	_children: MockRenderable[];
	getChildren(): MockRenderable[];
}

const asRenderable = (node: MockRenderable): Renderable =>
	node as unknown as Renderable;

const makeNode = (overrides: Partial<MockRenderable> = {}): MockRenderable => {
	const children = overrides._children ?? [];
	return {
		[RENDERABLE_BRAND]: true,
		backgroundColor: "mock",
		y: 0,
		visible: true,
		_children: children,
		getChildren() {
			return this._children;
		},
		...overrides,
	};
};

const card = (y: number): MockRenderable => makeNode({ y });

describe("getRenderedGridColumnCount", () => {
	it("returns the correct column count for the pre-virtualization flat structure", () => {
		const rowContainer = makeNode({
			_children: [
				card(0),
				card(0),
				card(0),
				card(6),
				card(6),
				card(6),
			],
		});
		const gridContent = makeNode({ _children: [rowContainer] });

		expect(getRenderedGridColumnCount(asRenderable(gridContent), 1)).toBe(3);
	});

	it("returns the correct column count for the virtualized nested structure", () => {
		const rowContainer = makeNode({
			y: 6,
			_children: [
				card(0),
				card(0),
				card(0),
				card(6),
				card(6),
				card(6),
			],
		});
		const topSpacer = makeNode({ y: 0, _children: [] });
		const bottomSpacer = makeNode({ y: 24, _children: [] });
		const outerWrapper = makeNode({
			_children: [topSpacer, rowContainer, bottomSpacer],
		});
		const gridContent = makeNode({ _children: [outerWrapper] });

		expect(getRenderedGridColumnCount(asRenderable(gridContent), 1)).toBe(3);
	});

	it("returns the correct column count when the virtualized wrapper has no spacers (scrolled to top)", () => {
		const rowContainer = makeNode({
			_children: [card(0), card(0), card(0), card(0)],
		});
		const outerWrapper = makeNode({ _children: [rowContainer] });
		const gridContent = makeNode({ _children: [outerWrapper] });

		expect(getRenderedGridColumnCount(asRenderable(gridContent), 1)).toBe(4);
	});

	it("falls back when the grid content is not a box renderable", () => {
		expect(getRenderedGridColumnCount(undefined, 2)).toBe(2);
	});
});
