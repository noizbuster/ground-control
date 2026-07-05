import { describe, expect, it } from "vitest";
import { type Session, SessionStatus } from "../src/types";
import { createDetailPanelContent, DetailPanel } from "../src/ui/DetailPanel";
import { createHierarchyViewContent } from "../src/ui/HierarchyView";

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
});
