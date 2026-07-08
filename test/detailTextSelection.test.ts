import "../src/lib/ffi-register.mjs";
import { Box, ScrollBox, Text } from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import {
	type DetailMouseEvent,
	handleDetailMouseDown,
} from "../src/lib/detailMouse";
import { patchTextBufferViewSelection } from "../src/lib/opentuiSelectionPatch";
import {
	getTextSelectionText,
	isTextSelectionInProgress,
	type TextSelectionSnapshot,
} from "../src/lib/textSelection";

patchTextBufferViewSelection();

const startsDetailTextSelection = async (
	overlayVisible: boolean,
): Promise<boolean> => {
	const { renderer, mockMouse, flush } = await createTestRenderer({
		width: 48,
		height: 12,
		useMouse: true,
	});

	renderer.root.add(
		Box(
			{
				width: "100%",
				height: "100%",
				backgroundColor: "#020617",
			},
			Box(
				{
					width: 32,
					height: 8,
					border: true,
					borderColor: "#334155",
					backgroundColor: "#0F172A",
				},
				ScrollBox(
					{
						width: 28,
						height: 4,
						margin: 2,
						backgroundColor: "#0F172A",
						wrapperOptions: { padding: 1 },
					},
					Box(
						{
							width: "100%",
							flexDirection: "column",
						},
						Text({ content: "Session ID session-1", width: "100%" }),
					),
				),
				Box({
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					visible: overlayVisible,
					border: overlayVisible,
					backgroundColor: "transparent",
					shouldFill: false,
					zIndex: 10,
				}),
			),
		),
	);

	renderer.start();
	try {
		await flush();
		await mockMouse.drag(5, 4, 14, 4, MouseButtons.LEFT, { delayMs: 0 });
		await flush();
		return renderer.getSelection() !== null;
	} finally {
		renderer.destroy();
	}
};

const selectionSnapshot = (
	overrides: Partial<TextSelectionSnapshot>,
): TextSelectionSnapshot => ({
	getSelectedText: () => " selected text ",
	...overrides,
});

const detailMouseEvent = (params: {
	button: DetailMouseEvent["button"];
	isDragging?: boolean;
}): { readonly event: DetailMouseEvent; readonly calls: Record<string, number> } => {
	const calls = {
		preventDefault: 0,
		stopPropagation: 0,
	};

	return {
		event: {
			button: params.button,
			isDragging: params.isDragging,
			preventDefault: () => {
				calls.preventDefault += 1;
			},
			stopPropagation: () => {
				calls.stopPropagation += 1;
			},
		},
		calls,
	};
};

describe("detail text selection", () => {
	it("treats the initial selection-start frame as active", () => {
		expect(isTextSelectionInProgress(null)).toBe(false);
		expect(isTextSelectionInProgress(selectionSnapshot({ isDragging: true }))).toBe(
			true,
		);
		expect(isTextSelectionInProgress(selectionSnapshot({ isStart: true }))).toBe(
			true,
		);
	});

	it("trims selected text before copying", () => {
		expect(getTextSelectionText(selectionSnapshot({}))).toBe("selected text");
	});

	it("keeps the detail frame overlay out of the text selection hit path", async () => {
		await expect(startsDetailTextSelection(false)).resolves.toBe(true);
		await expect(startsDetailTextSelection(true)).resolves.toBe(false);
	});

	it("focuses detail on left click without consuming text selection events", () => {
		const focusedPanes: string[] = [];
		let closeCount = 0;
		const { event, calls } = detailMouseEvent({ button: MouseButtons.LEFT });

		handleDetailMouseDown(event, {
			isDetailMode: true,
			isSideviewMode: false,
			setFocusedPane: (pane) => focusedPanes.push(pane),
			closeDetailView: () => {
				closeCount += 1;
			},
		});

		expect(focusedPanes).toEqual(["detail"]);
		expect(closeCount).toBe(0);
		expect(calls.preventDefault).toBe(0);
		expect(calls.stopPropagation).toBe(0);
	});

	it("consumes right click only when closing detail-only mode", () => {
		const focusedPanes: string[] = [];
		let closeCount = 0;
		const { event, calls } = detailMouseEvent({ button: MouseButtons.RIGHT });

		handleDetailMouseDown(event, {
			isDetailMode: true,
			isSideviewMode: false,
			setFocusedPane: (pane) => focusedPanes.push(pane),
			closeDetailView: () => {
				closeCount += 1;
			},
		});

		expect(focusedPanes).toEqual([]);
		expect(closeCount).toBe(1);
		expect(calls.preventDefault).toBe(1);
		expect(calls.stopPropagation).toBe(1);
	});
});
