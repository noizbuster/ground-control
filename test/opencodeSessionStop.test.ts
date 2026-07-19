import { describe, expect, it, vi } from "vitest";
import {
	postOpencodeSessionAbort,
	stopOpencodeSession,
} from "../src/db/opencode-session-stop";

describe("postOpencodeSessionAbort", () => {
	it("POSTs abort with directory header and query", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).toContain("/session/ses_test/abort");
			expect(url).toContain("directory=%2Fproj");
			expect(init?.method).toBe("POST");
			expect(
				(init?.headers as Record<string, string>)["x-opencode-directory"],
			).toBe("/proj");
			return new Response("true", { status: 200 });
		});

		const result = await postOpencodeSessionAbort(
			"http://127.0.0.1:41999",
			"ses_test",
			"/proj",
			fetchImpl as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: true, method: "abort" });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("maps non-OK HTTP to failure", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("nope", { status: 404 }),
		);
		const result = await postOpencodeSessionAbort(
			"http://127.0.0.1:41999",
			"ses_test",
			"/proj",
			fetchImpl as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("404");
	});
});

describe("stopOpencodeSession priority", () => {
	const settled = {
		abortSettleMs: 0,
		stopSettleMs: 0,
		sleep: async () => {},
		isSessionStillActive: () => false,
	};

	it("uses abort on discovered server before stop message", async () => {
		const sendStopMessage = vi.fn(async () => ({
			ok: true as const,
			method: "stop-message" as const,
		}));
		const withEphemeralServer = vi.fn(async (run) => run("http://ephemeral"));

		const result = await stopOpencodeSession({
			sessionId: "ses_a",
			directory: "/proj",
			discoverBaseUrls: async () => ["http://discovered"],
			fetchImpl: (async () =>
				new Response("true", { status: 200 })) as unknown as typeof fetch,
			withEphemeralServer,
			sendStopMessage,
			...settled,
		});

		expect(result).toEqual({ ok: true, method: "abort" });
		expect(withEphemeralServer).not.toHaveBeenCalled();
		expect(sendStopMessage).not.toHaveBeenCalled();
	});

	it("falls back to ephemeral abort when discovery is empty", async () => {
		const sendStopMessage = vi.fn(async () => ({
			ok: true as const,
			method: "stop-message" as const,
		}));
		let sawEphemeral = false;

		const result = await stopOpencodeSession({
			sessionId: "ses_a",
			directory: "/proj",
			discoverBaseUrls: async () => [],
			fetchImpl: (async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("http://ephemeral")) {
					sawEphemeral = true;
					return new Response("true", { status: 200 });
				}
				return new Response("no", { status: 404 });
			}) as unknown as typeof fetch,
			withEphemeralServer: async (run) => run("http://ephemeral"),
			sendStopMessage,
			...settled,
		});

		expect(result).toEqual({ ok: true, method: "abort" });
		expect(sawEphemeral).toBe(true);
		expect(sendStopMessage).not.toHaveBeenCalled();
	});

	it("falls back to stop message when abort paths fail", async () => {
		const sendStopMessage = vi.fn(async () => ({
			ok: true as const,
			method: "stop-message" as const,
		}));

		const result = await stopOpencodeSession({
			sessionId: "ses_a",
			directory: "/proj",
			discoverBaseUrls: async () => ["http://discovered"],
			fetchImpl: (async () =>
				new Response("no", { status: 500 })) as unknown as typeof fetch,
			withEphemeralServer: async (run) => run("http://ephemeral"),
			sendStopMessage,
			...settled,
		});

		expect(result).toEqual({ ok: true, method: "stop-message" });
		expect(sendStopMessage).toHaveBeenCalledOnce();
	});

	it("returns failure when stop claims ok but session stays active", async () => {
		const result = await stopOpencodeSession({
			sessionId: "ses_a",
			directory: "/proj",
			discoverBaseUrls: async () => [],
			withEphemeralServer: async () => {
				throw new Error("serve down");
			},
			sendStopMessage: async () => ({
				ok: true,
				method: "stop-message",
			}),
			abortSettleMs: 0,
			stopSettleMs: 1,
			sleep: async () => {},
			isSessionStillActive: () => true,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("still active");
	});

	it("returns failure when abort and stop message both fail", async () => {
		const result = await stopOpencodeSession({
			sessionId: "ses_a",
			directory: "/proj",
			discoverBaseUrls: async () => [],
			withEphemeralServer: async () => {
				throw new Error("serve down");
			},
			sendStopMessage: async () => ({
				ok: false,
				error: "stop message exit code 1",
			}),
			...settled,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("serve down");
		expect(result.error).toContain("stop message exit code 1");
	});
});
