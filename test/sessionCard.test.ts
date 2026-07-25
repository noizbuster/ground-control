import { describe, expect, it } from "vitest";
import type { Session, SubagentSession } from "../src/types";
import { SessionStatus } from "../src/types";
import { SessionCard, shortenDirectoryPath } from "../src/ui/SessionCard";
import { getSessionAgentDisplayName } from "../src/ui/sessionAgentDisplay";

const createSession = (overrides: Partial<Session> = {}): Session => ({
	id: "root-session",
	title: "Root session",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: null,
	time_created: 1_700_000_000_000,
	time_updated: 1_700_000_001_000,
	sessionSource: "omp",
	status: SessionStatus.running,
	subagentSessions: [],
	...overrides,
});

const createSubagentSession = (
	overrides: Partial<SubagentSession> = {},
): SubagentSession => ({
	id: "child-session",
	title: "Child session",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: "root-session",
	time_created: 1_700_000_000_500,
	time_updated: 1_700_000_001_000,
	sessionSource: "omp",
	status: SessionStatus.running,
	...overrides,
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null;
};

const getContentText = (content: unknown): string => {
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

const getRenderedTextLines = (node: unknown): string[] => {
	if (!isRecord(node)) {
		return [];
	}

	const props = isRecord(node.props) ? node.props : {};
	const contentText = getContentText(props.content);
	const ownLines = contentText.length > 0 ? [contentText] : [];
	const childLines = Array.isArray(node.children)
		? node.children.flatMap((child) => getRenderedTextLines(child))
		: [];

	return [...ownLines, ...childLines];
};

describe("shortenDirectoryPath", () => {
	it("shows only the last three directory segments with a leading ellipsis", () => {
		expect(
			shortenDirectoryPath("/home/noiz/projects/ground-control/src/ui", 32),
		).toBe("...ground-control/src/ui");
	});

	it("shrinks from the front as width gets tighter while preserving the last three segments", () => {
		const path = "/home/noiz/projects/ground-control/src/ui";
		expect(shortenDirectoryPath(path, 20)).toBe("...nd-control/src/ui");
		expect(shortenDirectoryPath(path, 14)).toBe("...trol/src/ui");
		expect(shortenDirectoryPath(path, 8)).toBe("...rc/ui");
	});

	it("returns the original path when it already fits", () => {
		expect(shortenDirectoryPath("/repo/app", 20)).toBe("/repo/app");
	});
});

describe("session stall edge", () => {
	it("renders an orange stalled edge after 5 minutes without updates", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.running,
					time_updated: Date.now() - 5 * 60 * 1000,
				}),
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[stalled]"))).toBe(true);
		expect(lines.some((line) => line.startsWith("[blocked]"))).toBe(false);
	});

	it("renders a red blocked edge with inactive minutes after 10 minutes", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.running,
					time_updated: Date.now() - 12 * 60 * 1000,
				}),
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[blocked] 12m"))).toBe(true);
		expect(lines.some((line) => line.startsWith("[stalled]"))).toBe(false);
	});

	it("prefers awaiting user over stalled when both would apply", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.waiting,
					time_updated: Date.now() - 10 * 60 * 1000,
				}),
				isWaiting: true,
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[awaiting user]"))).toBe(true);
		expect(lines.some((line) => line.startsWith("[stalled]"))).toBe(false);
		expect(lines.some((line) => line.startsWith("[blocked]"))).toBe(false);
	});

	it("renders awaiting_user sessions as awaiting user", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.waiting,
					finishReason: "awaiting_user",
				}),
				width: 38,
			}),
		);

		expect(lines).toContain("status  AWAITING USER");
		expect(lines.some((line) => line.startsWith("[awaiting user]"))).toBe(true);
	});

	it("does not render stall edges for idle sessions", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.waiting,
					finishReason: "end_turn",
					time_updated: Date.now() - 10 * 60 * 1000,
				}),
				isWaiting: true,
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[stalled]"))).toBe(false);
		expect(lines.some((line) => line.startsWith("[blocked]"))).toBe(false);
	});
});

describe("idle session card display", () => {
	const extractStatusLine = (lines: string[]): string | undefined =>
		lines.find((line) => line.startsWith("status  "));

	it("renders Mission Control idle as COMPLETED (not IDLE/unknown gray)", () => {
		const idleLines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					sessionSource: "mission-control",
					status: SessionStatus.idle,
					time_updated: Date.now() - 60 * 60 * 1000,
				}),
				width: 38,
			}),
		);
		const completedLines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					sessionSource: "mission-control",
					status: SessionStatus.completed,
					time_updated: Date.now() - 60 * 60 * 1000,
				}),
				width: 38,
			}),
		);

		expect(extractStatusLine(idleLines)).toBe("status  COMPLETED");
		expect(extractStatusLine(idleLines)).toBe(
			extractStatusLine(completedLines),
		);
		expect(idleLines.some((line) => line.includes("IDLE"))).toBe(false);
		expect(idleLines.some((line) => line.includes("UNKNOWN"))).toBe(false);
	});

	it("renders end_turn idle-waiting as COMPLETED on the card", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					status: SessionStatus.waiting,
					finishReason: "end_turn",
					time_updated: Date.now() - 60 * 60 * 1000,
				}),
				isWaiting: true,
				width: 38,
			}),
		);

		expect(extractStatusLine(lines)).toBe("status  COMPLETED");
		expect(lines.some((line) => line.startsWith("[awaiting user]"))).toBe(
			false,
		);
	});

	it("shows recently-completed edge for idle sessions completed within ten minutes", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					sessionSource: "mission-control",
					status: SessionStatus.idle,
					time_updated: Date.now() - 6 * 60 * 1000,
				}),
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[recently completed]"))).toBe(
			true,
		);
	});

	it("does not show recently-completed edge after ten minutes", () => {
		const lines = getRenderedTextLines(
			SessionCard({
				session: createSession({
					sessionSource: "mission-control",
					status: SessionStatus.idle,
					time_updated: Date.now() - (10 * 60 * 1000 + 1),
				}),
				width: 38,
			}),
		);

		expect(lines.some((line) => line.startsWith("[recently completed]"))).toBe(
			false,
		);
	});
});

describe("session agent display", () => {
	it("uses Default for root session card agents that would otherwise show Unknown", () => {
		const lines = getRenderedTextLines(
			SessionCard({ session: createSession(), width: 38 }),
		);

		expect(lines).toContain("agent   omp · Default");
	});

	it("uses Default for root sessions with explicit unknown agents", () => {
		const root = createSession({ currentAgent: "unknown" });

		expect(
			getSessionAgentDisplayName(root.currentAgent, { isRoot: true }),
		).toBe("Default");
	});

	it("keeps child sessions with missing agents as Unknown", () => {
		const child = createSubagentSession();

		expect(
			getSessionAgentDisplayName(child.currentAgent, { isRoot: false }),
		).toBe("Unknown");
	});

	it("keeps child sessions with explicit unknown agents as Unknown", () => {
		const child = createSubagentSession({ currentAgent: "unknown" });

		expect(
			getSessionAgentDisplayName(child.currentAgent, { isRoot: false }),
		).toBe("Unknown");
	});

	it("keeps explicit child agents unchanged", () => {
		const child = createSubagentSession({ currentAgent: "explore" });

		expect(
			getSessionAgentDisplayName(child.currentAgent, { isRoot: false }),
		).toBe("Explore");
	});
});
