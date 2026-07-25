import "../src/lib/ffi-register.mjs";
import {
	type BorderSides,
	Box,
	ScrollBox,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import {
	type Session,
	SessionStatus,
	type SubagentSession,
} from "../src/types";
import {
	createDetailPanelContent,
	DetailPanel,
	getDetailPanelContentWidth,
} from "../src/ui/DetailPanel";
import { createHierarchyViewContent } from "../src/ui/HierarchyView";

const RUNTIME_DETAIL_TERMINAL_WIDTH = 120;
const RUNTIME_DETAIL_TERMINAL_HEIGHT = 36;
const RUNTIME_DETAIL_PANE_WIDTH = 118;
const RUNTIME_DETAIL_PANE_HEIGHT = 32;
const RUNTIME_DETAIL_SCROLLBOX_WIDTH = 114;
const RUNTIME_DETAIL_SCROLLBOX_HEIGHT = 26;
const RUNTIME_DETAIL_SCROLLBOX_PADDING = 1;
const RUNTIME_DETAIL_SCROLLBAR_WIDTH = 2;
const RUNTIME_DETAIL_SCROLLBOX_ID = "session-detail-scrollbox";
const RUNTIME_DETAIL_FRAME_OVERLAY_ID = "session-detail-frame-overlay";
const RUNTIME_APP_BACKGROUND = "#020617";
const RUNTIME_DETAIL_BACKGROUND = "#0F172A";
const RUNTIME_DETAIL_BORDER = "#334155";
const RUNTIME_DETAIL_SECTION_BORDER_COLOR = "#1E293B";
const RUNTIME_DETAIL_SECTION_BORDER: BorderSides[] = ["top", "bottom"];

const sampleSession = (overrides: Partial<Session> = {}): Session => ({
	id: "session-1",
	title: "Session 상세보기 스크롤 겹침 문제 수정",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: null,
	time_created: 1_700_000_000_000,
	time_updated: 1_700_000_001_000,
	sessionSource: "opencode",
	status: SessionStatus.running,
	subagentSessions: [],
	...overrides,
});

const sampleSubagentSession = (
	overrides: Partial<SubagentSession> = {},
): SubagentSession => ({
	id: "child-1",
	title: "Child session",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: "session-1",
	time_created: 1_700_000_000_000,
	time_updated: 1_700_000_001_000,
	sessionSource: "opencode",
	status: SessionStatus.completed,
	...overrides,
});

const sampleRuntimeDetailData = (): {
	session: Session;
	sessions: Session[];
	messageCountBySessionId: Partial<Record<string, number>>;
} => {
	const subagentSessions = Array.from({ length: 28 }, (_, index) =>
		sampleSubagentSession({
			id: `child-${index + 1}`,
			title: `Child session ${index + 1}`,
			time_created: 1_700_000_000_000 + index,
			time_updated: 1_700_000_001_000 + index,
		}),
	);
	const session = sampleSession({
		title: "Session detail 텍스트 드래그 문제 해결",
		directory: "/home/noiz/projects/ground-control",
		project_label: "ground-control",
		currentAgent: "Sisyphus",
		currentModelID: "gpt-5.5",
		currentVariant: "xhigh",
		providerID: "openai",
		subagentSessions,
	});
	const relatedSessions = Array.from({ length: 32 }, (_, index) =>
		sampleSession({
			id: `peer-${index + 1}`,
			title: `Peer session ${index + 1}`,
			time_updated: 1_700_000_001_000 - index,
		}),
	);
	const sessions = [session, ...relatedSessions];
	const messageCountBySessionId: Partial<Record<string, number>> = {
		[session.id]: 189,
	};

	for (const [index, subagent] of subagentSessions.entries()) {
		messageCountBySessionId[subagent.id] = index + 1;
	}

	for (const [index, relatedSession] of relatedSessions.entries()) {
		messageCountBySessionId[relatedSession.id] = index + 200;
	}

	return { session, sessions, messageCountBySessionId };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (!isRecord(content) || !Array.isArray(content.chunks)) {
		return "";
	}

	return content.chunks
		.map((chunk) => {
			if (!isRecord(chunk) || typeof chunk.text !== "string") {
				return "";
			}

			return chunk.text;
		})
		.join("");
};

const childNodes = (node: unknown): unknown[] => {
	if (!isRecord(node) || !Array.isArray(node.children)) {
		return [];
	}

	return node.children;
};

const isScrollBoxRenderable = (
	renderable: unknown,
): renderable is ScrollBoxRenderable =>
	isRecord(renderable) && typeof renderable.scrollTo === "function";

const normalizeRuntimeDetailSectionBorders = (node: unknown): void => {
	if (!isRecord(node)) {
		return;
	}

	const props = isRecord(node.props) ? node.props : null;
	if (
		props?.border === true &&
		props.borderColor === RUNTIME_DETAIL_SECTION_BORDER_COLOR
	) {
		props.border = [...RUNTIME_DETAIL_SECTION_BORDER];
	}

	if (!Array.isArray(node.children)) {
		return;
	}

	for (const child of node.children) {
		normalizeRuntimeDetailSectionBorders(child);
	}
};

const hasDirectTitle = (node: unknown, title: string): boolean =>
	childNodes(node).some((child) => {
		if (!isRecord(child)) {
			return false;
		}

		const props = isRecord(child.props) ? child.props : {};
		return textFromContent(props.content).includes(title);
	});

const findSectionByTitle = (
	node: unknown,
	title: string,
): Record<string, unknown> | null => {
	if (isRecord(node) && hasDirectTitle(node, title)) {
		return node;
	}

	for (const child of childNodes(node)) {
		const section = findSectionByTitle(child, title);
		if (section) {
			return section;
		}
	}

	return null;
};

const sectionByTitle = (
	root: unknown,
	title: string,
): Record<string, unknown> => {
	const section = findSectionByTitle(root, title);

	if (!section) {
		throw new TypeError(`Section not found: ${title}`);
	}

	return section;
};

const renderRuntimeDetailFrame = async ({
	contentWidth,
	scrollTop = 0,
}: {
	contentWidth: number;
	scrollTop?: number;
}): Promise<string> => {
	const { session, sessions, messageCountBySessionId } =
		sampleRuntimeDetailData();
	const { renderer, flush, captureCharFrame } = await createTestRenderer({
		width: RUNTIME_DETAIL_TERMINAL_WIDTH,
		height: RUNTIME_DETAIL_TERMINAL_HEIGHT,
		screenMode: "alternate-screen",
	});
	const detailPanelContent = createDetailPanelContent({
		session,
		sessions,
		messageCount: 189,
		messageCountBySessionId,
		status: SessionStatus.running,
		width: contentWidth,
	});
	normalizeRuntimeDetailSectionBorders(detailPanelContent);
	const detailScrollBox = ScrollBox(
		{
			id: RUNTIME_DETAIL_SCROLLBOX_ID,
			width: RUNTIME_DETAIL_SCROLLBOX_WIDTH,
			height: RUNTIME_DETAIL_SCROLLBOX_HEIGHT,
			margin: 2,
			backgroundColor: RUNTIME_DETAIL_BACKGROUND,
			wrapperOptions: { padding: RUNTIME_DETAIL_SCROLLBOX_PADDING },
		},
		Box(
			{
				width: "100%",
				flexDirection: "column",
			},
			detailPanelContent,
		),
	);

	renderer.root.add(
		Box(
			{
				width: RUNTIME_DETAIL_TERMINAL_WIDTH,
				height: RUNTIME_DETAIL_TERMINAL_HEIGHT,
				backgroundColor: RUNTIME_APP_BACKGROUND,
				paddingTop: 1,
				paddingLeft: 1,
				paddingRight: 1,
			},
			Box(
				{
					width: RUNTIME_DETAIL_PANE_WIDTH,
					height: RUNTIME_DETAIL_PANE_HEIGHT,
					border: true,
					borderColor: RUNTIME_DETAIL_BORDER,
					backgroundColor: RUNTIME_DETAIL_BACKGROUND,
					overflow: "hidden",
				},
				detailScrollBox,
				Box({
					id: RUNTIME_DETAIL_FRAME_OVERLAY_ID,
					position: "absolute",
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					visible: false,
					border: false,
					borderColor: RUNTIME_DETAIL_BORDER,
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
		if (scrollTop > 0) {
			const mountedDetailScrollBox = renderer.root.findDescendantById(
				RUNTIME_DETAIL_SCROLLBOX_ID,
			);
			if (!isScrollBoxRenderable(mountedDetailScrollBox)) {
				throw new TypeError("Detail scrollbox not mounted");
			}

			mountedDetailScrollBox.scrollTo({ x: 0, y: scrollTop });
			await flush();
		}
		return captureCharFrame();
	} finally {
		renderer.destroy();
	}
};

const lineAt = (lines: readonly string[], index: number): string => {
	if (index < 0 || index >= lines.length) {
		return "";
	}

	return lines[index] ?? "";
};

const hasHorizontalBorderRun = (
	line: string,
	leftCorner: string,
	rightCorner: string,
): boolean => {
	const leftIndex = line.indexOf(leftCorner);
	const rightIndex = line.lastIndexOf(rightCorner);

	if (leftIndex < 0 || rightIndex <= leftIndex) {
		return false;
	}

	return /─{3,}/u.test(line.slice(leftIndex + 1, rightIndex));
};

const frameInteriorSegment = (
	line: string,
	leftCorner: string,
	rightCorner: string,
): string => {
	const leftIndex = line.indexOf(leftCorner);
	const rightIndex = line.lastIndexOf(rightCorner);

	if (leftIndex < 0 || rightIndex <= leftIndex) {
		return "";
	}

	return line.slice(leftIndex + 1, rightIndex);
};

const isCleanHorizontalFrameInterior = (segment: string): boolean =>
	/^─+$/u.test(segment);

const hasInternalSectionBorderFragment = (line: string): boolean =>
	/[│┌└]/u.test(line);

describe("scrollable section borders", () => {
	it("keeps detail sections visibly bordered", () => {
		const session = sampleSession();
		const content = createDetailPanelContent({
			session,
			sessions: [session],
			messageCount: 1,
			messageCountBySessionId: { [session.id]: 1 },
			status: SessionStatus.running,
			width: 80,
		});

		expect(sectionByTitle(content, "Overview").props).toMatchObject({
			border: true,
			borderColor: "#1E293B",
			padding: 1,
		});
		expect(sectionByTitle(content, "Session Metadata").props).toMatchObject({
			border: true,
			borderColor: "#1E293B",
			padding: 1,
		});
	});

	it("keeps hierarchy sections visibly bordered", () => {
		const session = sampleSession();
		const content = createHierarchyViewContent({
			session,
			messageCountBySessionId: { [session.id]: 1 },
			width: 80,
			viewMode: "tree",
			filterMode: "all",
			infoMode: "standard",
		});

		expect(sectionByTitle(content, "Agent Hierarchy").props).toMatchObject({
			border: true,
			borderColor: "#1E293B",
			padding: 1,
		});
		expect(sectionByTitle(content, "Tree").props).toMatchObject({
			border: true,
			borderColor: "#1E293B",
			padding: 1,
		});
	});

	it("uses a fixed detail viewport inset instead of scroll-content padding", () => {
		const session = sampleSession();
		const panel = DetailPanel({
			session,
			sessions: [session],
			messageCount: 1,
			messageCountBySessionId: { [session.id]: 1 },
			status: SessionStatus.running,
			summary: "Summary",
			scrollBoxId: "detail-test-scrollbox",
			width: 80,
			height: 24,
		});

		expect(panel.props).toMatchObject({
			border: true,
			wrapperOptions: { padding: 2 },
		});
		expect(panel.props).not.toHaveProperty("padding");
	});

	it("renders the selected model only in the detail header when available", () => {
		const session = sampleSession({
			currentModelID: "gpt-5.5",
			currentReasoningEffort: "xhigh",
		});
		const contentWithModel = createDetailPanelContent({
			session,
			sessions: [session],
			messageCount: 1,
			messageCountBySessionId: { [session.id]: 1 },
			status: SessionStatus.running,
			width: 80,
		});
		const headerBadgeTexts = childNodes(childNodes(contentWithModel)[2]).map(
			(badge) => {
				const textNode = childNodes(badge)[0];
				const props =
					isRecord(textNode) && isRecord(textNode.props) ? textNode.props : {};
				return textFromContent(props.content);
			},
		);

		expect(headerBadgeTexts).toContain("Model gpt-5.5");
		expect(headerBadgeTexts.indexOf("Model gpt-5.5")).toBeLessThan(
			headerBadgeTexts.indexOf("Reasoning xhigh"),
		);

		const sessionWithoutModel = sampleSession();
		const contentWithoutModel = createDetailPanelContent({
			session: sessionWithoutModel,
			sessions: [sessionWithoutModel],
			messageCount: 1,
			messageCountBySessionId: { [sessionWithoutModel.id]: 1 },
			status: SessionStatus.running,
			width: 80,
		});
		const missingModelBadgeTexts = childNodes(
			childNodes(contentWithoutModel)[2],
		).map((badge) => {
			const textNode = childNodes(badge)[0];
			const props =
				isRecord(textNode) && isRecord(textNode.props) ? textNode.props : {};
			return textFromContent(props.content);
		});

		expect(
			missingModelBadgeTexts.some((text) => text.startsWith("Model")),
		).toBe(false);
	});

	it("closes the runtime detail metadata top border at 120 columns", async () => {
		const contentWidth = getDetailPanelContentWidth(
			RUNTIME_DETAIL_SCROLLBOX_WIDTH,
			RUNTIME_DETAIL_SCROLLBOX_PADDING,
			RUNTIME_DETAIL_SCROLLBAR_WIDTH,
		);
		const frame = await renderRuntimeDetailFrame({ contentWidth });
		const lines = frame.split("\n");
		const metadataTitleIndex = lines.findIndex((line) =>
			line.includes("Session Metadata"),
		);

		expect(contentWidth).toBe(110);
		expect(metadataTitleIndex).toBeGreaterThan(0);

		const topBorderLine =
			lines
				.slice(0, metadataTitleIndex)
				.reverse()
				.find((line) => line.includes("┌")) ?? "";
		const firstTopCornerIndex = topBorderLine.indexOf("┌");
		const metadataTopCornerIndex = topBorderLine.indexOf(
			"┌",
			firstTopCornerIndex + 1,
		);
		const metadataTopBorderSegment = topBorderLine.slice(
			metadataTopCornerIndex,
		);
		const metadataTopCloseIndex = metadataTopBorderSegment.indexOf("┐");
		const detailPaneRightBorderIndex = metadataTopBorderSegment.indexOf("│");
		const maxLineWidth = Math.max(
			...lines.map((line) => line.trimEnd().length),
		);

		expect(firstTopCornerIndex).toBeGreaterThanOrEqual(0);
		expect(metadataTopCornerIndex).toBeGreaterThan(firstTopCornerIndex);
		expect(metadataTopCloseIndex).toBeGreaterThan(0);
		expect(
			detailPaneRightBorderIndex === -1 ||
				metadataTopCloseIndex < detailPaneRightBorderIndex,
		).toBe(true);
		expect(maxLineWidth).toBeLessThanOrEqual(RUNTIME_DETAIL_TERMINAL_WIDTH);
	});

	it("keeps the scrolled runtime detail frame borders visible at 120 columns", async () => {
		const contentWidth = getDetailPanelContentWidth(
			RUNTIME_DETAIL_SCROLLBOX_WIDTH,
			RUNTIME_DETAIL_SCROLLBOX_PADDING,
			RUNTIME_DETAIL_SCROLLBAR_WIDTH,
		);
		const frame = await renderRuntimeDetailFrame({
			contentWidth,
			scrollTop: 8,
		});
		const lines = frame.split("\n");
		const topFrameIndex = lines.findIndex(
			(line) => line.includes("┌") && line.includes("┐"),
		);
		const bottomFrameIndex = lines.findLastIndex(
			(line) => line.includes("└") && line.includes("┘"),
		);
		const topFrameLine = lineAt(lines, topFrameIndex);
		const bottomFrameLine = lineAt(lines, bottomFrameIndex);

		expect(contentWidth).toBe(110);
		expect(topFrameIndex).toBeGreaterThan(0);
		expect(bottomFrameIndex).toBeGreaterThan(topFrameIndex);
		expect(hasHorizontalBorderRun(topFrameLine, "┌", "┐")).toBe(true);
		expect(hasHorizontalBorderRun(bottomFrameLine, "└", "┘")).toBe(true);
		expect(
			isCleanHorizontalFrameInterior(
				frameInteriorSegment(topFrameLine, "┌", "┐"),
			),
		).toBe(true);
		expect(
			isCleanHorizontalFrameInterior(
				frameInteriorSegment(bottomFrameLine, "└", "┘"),
			),
		).toBe(true);
		expect(
			hasInternalSectionBorderFragment(lineAt(lines, topFrameIndex - 1)),
		).toBe(false);
		expect(
			hasInternalSectionBorderFragment(lineAt(lines, bottomFrameIndex + 1)),
		).toBe(false);
	});
});
