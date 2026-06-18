import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	readLatestMessagesAndCountsFromDatabase,
	readLatestMessagesFromDatabase,
	readMessageCountsFromDatabase,
	readWaitingSignalsFromDatabase,
} from "../src/db";
import type { MessageData } from "../src/types";

let database: Database;

const createMessage = (message: MessageData | string): string =>
	typeof message === "string" ? message : JSON.stringify(message);

const insertMessage = (
	sessionId: string,
	message: MessageData | string,
	timeCreated: number,
): void => {
	database.run(
		"INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)",
		sessionId,
		createMessage(message),
		timeCreated,
	);
};

const insertPart = (
	sessionId: string,
	part: Record<string, unknown>,
	timeCreated: number,
): void => {
	database.run(
		"INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)",
		sessionId,
		JSON.stringify(part),
		timeCreated,
	);
};

beforeEach(() => {
	database = new Database(":memory:");
	database.run(
		"CREATE TABLE message (session_id TEXT NOT NULL, data TEXT, time_created INTEGER NOT NULL)",
	);
	database.run(
		"CREATE TABLE part (session_id TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL)",
	);
});

afterEach(() => {
	database.close();
});

describe("DB query helpers", () => {
	it("returns the latest parsed message per requested session", () => {
		insertMessage(
			"running",
			{ role: "assistant", time: { created: 1 } },
			1,
		);
		insertMessage(
			"running",
			{ role: "assistant", time: { created: 2 }, finish: "stop" },
			2,
		);
		insertMessage("broken", "{not-json", 3);
		insertMessage(
			"tied",
			{ role: "assistant", time: { created: 4 } },
			4,
		);
		insertMessage(
			"tied",
			{ role: "assistant", time: { created: 5 }, finish: "error" },
			4,
		);

		expect(
			readLatestMessagesFromDatabase(database, ["running", "broken", "tied"]),
		).toEqual({
			running: {
				sessionId: "running",
				rawData: JSON.stringify({
					role: "assistant",
					time: { created: 2 },
					finish: "stop",
				}),
				message: {
					ok: true,
					value: {
						role: "assistant",
						time: { created: 2 },
						finish: "stop",
					},
				},
			},
			broken: {
				sessionId: "broken",
				rawData: "{not-json",
				message: {
					ok: false,
					error: {
						code: "invalid_json",
						message: expect.any(String),
					},
				},
			},
			tied: {
				sessionId: "tied",
				rawData: JSON.stringify({
					role: "assistant",
					time: { created: 5 },
					finish: "error",
				}),
				message: {
					ok: true,
					value: {
						role: "assistant",
						time: { created: 5 },
						finish: "error",
					},
				},
			},
		});
	});

	it("counts messages only for the requested sessions", () => {
		insertMessage("alpha", { role: "assistant", time: { created: 1 } }, 1);
		insertMessage("alpha", { role: "assistant", time: { created: 2 } }, 2);
		insertMessage("beta", { role: "user", time: { created: 3 } }, 3);
		insertMessage("ignored", { role: "assistant", time: { created: 4 } }, 4);

		expect(readMessageCountsFromDatabase(database, ["alpha", "beta"])).toEqual({
			alpha: 2,
			beta: 1,
		});
	});

	it("merges latest user times with latest question tool parts", () => {
		insertMessage("waiting", { role: "user", time: { created: 10 } }, 10);
		insertMessage("userOnly", { role: "user", time: { created: 30 } }, 30);
		insertMessage("toolStopped", { role: "user", time: { created: 40 } }, 40);

		insertPart(
			"waiting",
			{ type: "tool", tool: "question", state: { status: "running" } },
			11,
		);
		insertPart(
			"toolStopped",
			{ type: "tool", tool: "question", state: { status: "completed" } },
			41,
		);
		insertPart(
			"wrongTool",
			{ type: "tool", tool: "search", state: { status: "running" } },
			50,
		);

		expect(
			readWaitingSignalsFromDatabase(database, [
				"waiting",
				"userOnly",
				"toolStopped",
				"wrongTool",
			]),
		).toEqual({
			waiting: {
				latestUserMessageTime: 10,
				latestQuestionToolTime: 11,
				questionToolRunning: true,
			},
			userOnly: {
				latestUserMessageTime: 30,
				questionToolRunning: false,
			},
			toolStopped: {
				latestUserMessageTime: 40,
				latestQuestionToolTime: 41,
				questionToolRunning: false,
			},
		});
	});
});

describe("readLatestMessagesAndCountsFromDatabase", () => {
	it("returns latestMessages equal to readLatestMessagesFromDatabase on the same fixture", () => {
		insertMessage("running", { role: "assistant", time: { created: 1 } }, 1);
		insertMessage(
			"running",
			{ role: "assistant", time: { created: 2 }, finish: "stop" },
			2,
		);
		insertMessage("broken", "{not-json", 3);
		insertMessage("tied", { role: "assistant", time: { created: 4 } }, 4);
		insertMessage(
			"tied",
			{ role: "assistant", time: { created: 5 }, finish: "error" },
			4,
		);

		const sessionIds = ["running", "broken", "tied", "empty"];
		const result = readLatestMessagesAndCountsFromDatabase(
			database,
			sessionIds,
		);
		const expectedLatest = readLatestMessagesFromDatabase(
			database,
			sessionIds,
		);

		expect(result.latestMessages).toEqual(expectedLatest);
	});

	it("returns messageCounts equal to readMessageCountsFromDatabase on the same fixture", () => {
		insertMessage("alpha", { role: "assistant", time: { created: 1 } }, 1);
		insertMessage("alpha", { role: "assistant", time: { created: 2 } }, 2);
		insertMessage("beta", { role: "user", time: { created: 3 } }, 3);

		const sessionIds = ["alpha", "beta", "empty"];
		const result = readLatestMessagesAndCountsFromDatabase(
			database,
			sessionIds,
		);
		const expectedCounts = readMessageCountsFromDatabase(
			database,
			sessionIds,
		);

		expect(result.messageCounts).toEqual(expectedCounts);
	});

	it("resolves time_created ties by keeping the higher rowid (second insert wins)", () => {
		insertMessage("tied", { role: "assistant", time: { created: 4 } }, 4);
		insertMessage(
			"tied",
			{ role: "assistant", time: { created: 5 }, finish: "error" },
			4,
		);

		const result = readLatestMessagesAndCountsFromDatabase(database, [
			"tied",
		]);

		expect(result.latestMessages["tied"]?.message.value?.finish).toBe(
			"error",
		);
	});

	it("omits zero-message sessions from both latestMessages and messageCounts", () => {
		insertMessage(
			"present",
			{ role: "assistant", time: { created: 1 } },
			1,
		);

		const result = readLatestMessagesAndCountsFromDatabase(database, [
			"present",
			"empty",
		]);

		expect(result.latestMessages["empty"]).toBeUndefined();
		expect(result.messageCounts["empty"]).toBeUndefined();
	});

	it("preserves malformed JSON in rawData with message.ok === false", () => {
		insertMessage("broken", "{not-json", 3);

		const result = readLatestMessagesAndCountsFromDatabase(database, [
			"broken",
		]);

		expect(result.latestMessages["broken"]?.rawData).toBe("{not-json");
		expect(result.latestMessages["broken"]?.message.ok).toBe(false);
	});
});
