import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	executeMissionControlFallback,
	prepareMissionControlChildAbort,
} from "../src/lib/missionControlChildAbort";
import {
	dataDir,
	deletedIds,
	expireLeases,
	installNewRunProjection,
	metadata,
	selectedRoot,
	sessionRows,
	sessionState,
	snapshot,
	stateById,
	tableRows,
} from "./missionControlChildAbortE2eDatabase";
import {
	type OwnerFixtureProcess,
	runMissionControl,
	startOwnerFixture,
} from "./missionControlChildAbortE2eSupport";
import { registerOwnerFixtureProtocolE2e } from "./missionControlOwnerFixtureProtocolE2e";

const e2eConfigured = process.env.GCTRL_MC_E2E_TEMP_ROOT !== undefined;
const temporaryRoot = process.env.GCTRL_MC_E2E_TEMP_ROOT ?? "/tmp";
const owners: OwnerFixtureProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
	const ownersToClose = owners.splice(0);
	const rootsToRemove = roots.splice(0);
	try {
		await Promise.all(ownersToClose.map((owner) => owner.shutdown()));
	} finally {
		for (const owner of ownersToClose) owner.kill();
		await Promise.all(ownersToClose.map((owner) => owner.exited));
		for (const root of rootsToRemove)
			rmSync(root, { recursive: true, force: true });
	}
});

describe("cross-process Mission Control child-only abort", () => {
	if (!e2eConfigured) {
		it.skip("requires the shell-free cross-repository runner", () => {});
		return;
	}
	registerOwnerFixtureProtocolE2e(startScenario);
	it("settles active and blocked owners with truthful entity rows", async () => {
		for (const scenario of ["active", "blocked"] as const) {
			const fixture = await startScenario(scenario);
			const ready = await fixture.ready;
			const result = await runMissionControl(dataDir(ready.dbPath), [
				"session",
				"stop",
				"mc-stop-root",
				"--child-only",
			]);

			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(result.stdout).toBe(
				"Stopped 1/1 session(s) (0 already idle, 0 already terminal).\n",
			);
			expect(sessionState(ready.dbPath, "mc-stop-root")).toEqual({
				status: "running",
			});
			expect(sessionState(ready.dbPath, "mc-stop-child")).toEqual({
				status: "idle",
				lifecycleReason: "aborted",
			});
			const markers = tableRows(
				ready.dbPath,
				"SELECT type FROM session_events WHERE type = 'session.abort.completed'",
			);
			expect(markers).toHaveLength(1);
			if (scenario === "blocked") {
				expect(tableRows(ready.dbPath, "SELECT status FROM approvals")).toEqual(
					[{ status: "cancelled" }],
				);
				expect(
					tableRows(ready.dbPath, "SELECT status FROM session_inputs"),
				).toEqual([{ status: "cancelled" }]);
			}
		}
	});

	it("keeps the root running while stopping the full descendant tree across two DB identities", async () => {
		const first = await startScenario("tree");
		const second = await startScenario("tree");
		const firstReady = await first.ready;
		const secondReady = await second.ready;
		const beforeFirst = snapshot(firstReady.dbPath);
		const beforeSecond = snapshot(secondReady.dbPath);
		expect(metadata(selectedRoot(beforeFirst)).databaseIdentity).not.toBe(
			metadata(selectedRoot(beforeSecond)).databaseIdentity,
		);

		const stopped = await runMissionControl(dataDir(firstReady.dbPath), [
			"session",
			"stop",
			"mc-stop-root",
			"--child-only",
		]);

		expect(stopped).toMatchObject({ exitCode: 0, stderr: "" });
		expect(stopped.stdout).toBe(
			"Stopped 2/2 session(s) (0 already idle, 0 already terminal).\n",
		);
		expect(stateById(firstReady.dbPath)).toEqual({
			"mc-stop-child": "idle:aborted",
			"mc-stop-grandchild": "idle:aborted",
			"mc-stop-root": "running",
		});
		expect(stateById(secondReady.dbPath)).toEqual({
			"mc-stop-child": "running",
			"mc-stop-grandchild": "idle",
			"mc-stop-root": "running",
		});
		expect(
			tableRows(
				firstReady.dbPath,
				"SELECT status,cancellation_reason FROM async_jobs",
			),
		).toEqual([
			{ status: "cancelled", cancellation_reason: "operator_aborted" },
		]);
	});

	it("reports a partial timeout and fences old settlement from a newer run", async () => {
		const fixture = await startScenario("noncooperative");
		const ready = await fixture.ready;
		const stopped = await runMissionControl(dataDir(ready.dbPath), [
			"session",
			"stop",
			"mc-stop-root",
			"--child-only",
			"--timeout",
			"100ms",
		]);

		expect(stopped).toMatchObject({ exitCode: 1, stderr: "" });
		expect(stopped.stdout).toBe("Stopped 1/2 session(s); 1 failed.\n");
		expect(sessionState(ready.dbPath, "mc-stop-child")).toEqual({
			status: "idle",
			lifecycleReason: "aborted",
		});
		expect(sessionState(ready.dbPath, "mc-stop-grandchild").status).toBe(
			"running",
		);
		expect(
			tableRows(
				ready.dbPath,
				"SELECT status FROM session_control_operations WHERE session_id = 'mc-stop-grandchild'",
			),
		).toEqual([{ status: "timed_out" }]);

		installNewRunProjection(ready.dbPath, "mc-stop-grandchild");
		await fixture.command({
			command: "release",
			handleId: "provider:mc-stop-grandchild",
		});
		const latest = tableRows(
			ready.dbPath,
			"SELECT state,run_id FROM session_projection_runs " +
				"WHERE session_id = 'mc-stop-grandchild' ORDER BY sequence DESC LIMIT 1",
		);
		expect(latest).toEqual([{ state: "running", run_id: "run-new" }]);
		expect(sessionState(ready.dbPath, "mc-stop-grandchild").status).toBe(
			"running",
		);
	});

	it("routes owner death through two-refresh guarded affected-subtree deletion", async () => {
		const fixture = await startScenario("owner-death");
		const ready = await fixture.ready;
		await fixture.exited;
		expireLeases(ready.dbPath);
		const current = snapshot(ready.dbPath);
		const preparation = await prepareMissionControlChildAbort(
			selectedRoot(current),
			{
				refreshAfterStop: async () => undefined,
				stopChildren: async (parentSessionId, databasePath) =>
					runMissionControl(dataDir(databasePath), [
						"session",
						"stop",
						parentSessionId,
						"--child-only",
					]),
				readSnapshot: () => ({ ok: true, value: snapshot(ready.dbPath) }),
			},
		);

		expect(preparation.kind).toBe("fallback");
		if (preparation.kind !== "fallback") return;
		expect(preparation.plan.roots.map((root) => root.sessionId)).toEqual([
			"mc-stop-child",
		]);
		const executed = await executeMissionControlFallback(
			preparation.plan,
			["mc-stop-child"],
			{
				readSnapshot: () => ({ ok: true, value: snapshot(ready.dbPath) }),
				deleteSession: async (sessionId, options) => {
					const result = await runMissionControl(
						dataDir(options.databasePath),
						[
							"session",
							"delete",
							sessionId,
							"--expected-tree-token",
							options.expectedTreeToken,
						],
					);
					return result.exitCode === 0
						? {
								ok: true,
								value: {
									deletedSessionIds: deletedIds(result.stdout),
									stdout: result.stdout,
								},
							}
						: {
								ok: false,
								error: {
									code: "query_failed",
									message: result.stderr || result.stdout,
								},
							};
				},
			},
		);

		expect(executed).toEqual({ ok: true, deletedRootIds: ["mc-stop-child"] });
		expect(sessionRows(ready.dbPath).map((row) => row.session_id)).toEqual([
			"mc-stop-root",
		]);
	});
}, 20_000);

async function startScenario(
	scenario: Parameters<typeof startOwnerFixture>[0]["scenario"],
) {
	const root = mkdtempSync(join(temporaryRoot, `${scenario}-`));
	roots.push(root);
	const dataDir = join(root, "data");
	const runtimeDir = join(root, "runtime");
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const owner = startOwnerFixture({ dataDir, runtimeDir, scenario });
	owners.push(owner);
	return owner;
}
