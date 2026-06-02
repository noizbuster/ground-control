import { describe, expect, it } from "bun:test";
import {
	buildCodexSessionSnapshot,
	type CodexThreadRow,
	type CodexThreadSpawnEdgeRow,
	summarizeCodexSessionLogContent,
} from "../src/db/codex";

const parentThread: CodexThreadRow = {
	id: "019e87ba-5405-7823-bf57-d7cc2079a47d",
	source: "cli",
	model_provider: "openai",
	cwd: "/home/noiz/project/mission-control",
	title:
		"$omo:ulw-plan boilerplating 안에 있는 파일들 순서대로 따르면서 이 프로젝트를 보일러 플레이팅 하도록 계획을 짜",
	agent_role: null,
	agent_nickname: null,
	model: "gpt-5.5",
	reasoning_effort: "xhigh",
	archived: 0,
	created_at_ms: 1_780_000_000_000,
	updated_at_ms: 1_780_000_001_000,
};

const subagentThread: CodexThreadRow = {
	id: "019e87be-6f92-7fa3-89af-1bcaa7e112b2",
	source: JSON.stringify({
		subagent: {
			thread_spawn: {
				parent_thread_id: parentThread.id,
				depth: 1,
				agent_path: "/root/boilerplating_ordering_consult",
				agent_nickname: "Planner the 2nd",
				agent_role: "plan",
			},
		},
	}),
	model_provider: "openai",
	cwd: "/home/noiz/project/mission-control",
	title: "",
	agent_role: "plan",
	agent_nickname: "Planner the 2nd",
	model: "gpt-5.5",
	reasoning_effort: "xhigh",
	archived: 0,
	created_at_ms: 1_780_000_002_000,
	updated_at_ms: 1_780_000_003_000,
};

const reviewThread: CodexThreadRow = {
	id: "019e87c8-6a4b-7453-88f0-5c44bf0c099a",
	source: JSON.stringify({
		subagent: {
			thread_spawn: {
				parent_thread_id: parentThread.id,
				depth: 1,
				agent_path: "/root/plan_review",
				agent_nickname: "Reviewer the 5th",
				agent_role: "momus",
			},
		},
	}),
	model_provider: "openai",
	cwd: "/home/noiz/project/mission-control",
	title: "",
	agent_role: "momus",
	agent_nickname: "Reviewer the 5th",
	model: "gpt-5.5",
	reasoning_effort: "xhigh",
	archived: 0,
	created_at_ms: 1_780_000_004_000,
	updated_at_ms: 1_780_000_005_000,
};

const openEdge: CodexThreadSpawnEdgeRow = {
	parent_thread_id: parentThread.id,
	child_thread_id: subagentThread.id,
	status: "open",
};

const reviewEdge: CodexThreadSpawnEdgeRow = {
	parent_thread_id: parentThread.id,
	child_thread_id: reviewThread.id,
	status: "open",
};

const orderingConsultAssignmentContent =
	"Use omo:ulw-plan. This is a consult only: do not write source code and do not create a plans/*.md file. Task: Recommend ordering, wave structure, and verification emphasis for a decision-complete plan to boilerplate /home/noiz/project/mission-control by following these files in strict order.";

const buildAssignmentLog = (): string =>
	[
		JSON.stringify({
			timestamp: "2026-06-02T09:51:05.200Z",
			type: "session_meta",
			payload: {
				id: subagentThread.id,
				cwd: "/home/noiz/project/mission-control",
				source: {
					subagent: {
						thread_spawn: {
							parent_thread_id: parentThread.id,
							depth: 1,
							agent_path: "/root/boilerplating_ordering_consult",
							agent_nickname: "Planner the 2nd",
							agent_role: "plan",
						},
					},
				},
				thread_source: "subagent",
				agent_nickname: "Planner the 2nd",
				agent_role: "plan",
				agent_path: "/root/boilerplating_ordering_consult",
				model_provider: "openai",
			},
		}),
		JSON.stringify({
			timestamp: "2026-06-02T09:51:05.300Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: JSON.stringify({
							author: "/root",
							recipient: "/root/boilerplating_ordering_consult",
							other_recipients: [],
							content: orderingConsultAssignmentContent,
							trigger_turn: true,
						}),
					},
				],
			},
		}),
	].join("\n");

const buildPathAssignmentLog = (): string =>
	[
		JSON.stringify({
			timestamp: "2026-06-02T10:01:59.100Z",
			type: "session_meta",
			payload: {
				id: reviewThread.id,
				cwd: "/home/noiz/project/mission-control",
				thread_source: "subagent",
				agent_nickname: "Reviewer the 5th",
				agent_role: "momus",
				agent_path: "/root/plan_review",
				model_provider: "openai",
			},
		}),
		JSON.stringify({
			timestamp: "2026-06-02T10:01:59.200Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: JSON.stringify({
					author: "/root",
					recipient: "/root/plan_review",
					other_recipients: [],
					content: "plans/boilerplate-mission-control.md",
					trigger_turn: true,
				}),
			},
		}),
	].join("\n");

describe("Codex subagent titles", () => {
	it("uses the subagent assignment payload when the database title is empty", () => {
		const summary = summarizeCodexSessionLogContent(buildAssignmentLog());

		const snapshot = buildCodexSessionSnapshot({
			threads: [parentThread, subagentThread],
			edges: [openEdge],
			logSummaries: {
				[parentThread.id]: {
					messageCount: 1,
					taskState: "completed",
				},
				[subagentThread.id]: summary,
			},
		});

		const [root] = snapshot.sessions;
		const [subagent] = root.subagentSessions ?? [];

		expect(
			subagent?.title.startsWith(
				orderingConsultAssignmentContent.slice(0, 120),
			),
		).toBe(true);
	});

	it("keeps path-like assignment payloads visible in the generated title", () => {
		const summary = summarizeCodexSessionLogContent(buildPathAssignmentLog());

		const snapshot = buildCodexSessionSnapshot({
			threads: [parentThread, reviewThread],
			edges: [reviewEdge],
			logSummaries: {
				[parentThread.id]: {
					messageCount: 1,
					taskState: "completed",
				},
				[reviewThread.id]: summary,
			},
		});

		const [root] = snapshot.sessions;
		const [subagent] = root.subagentSessions ?? [];

		expect(subagent?.title).toBe("plans/boilerplate-mission-control.md");
	});
});
