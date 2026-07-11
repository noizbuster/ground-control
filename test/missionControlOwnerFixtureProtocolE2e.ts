import { expect, it } from "vitest";
import type { OwnerFixtureProcess } from "./missionControlChildAbortE2eSupport";

export function registerOwnerFixtureProtocolE2e(
	startScenario: (scenario: "active") => Promise<OwnerFixtureProcess>,
): void {
	it("uses the exact ready and stdin acknowledgement protocol", async () => {
		const fixture = await startScenario("active");
		const ready = await fixture.ready;
		expect(ready).toEqual({
			type: "ready",
			scenario: "active",
			dbPath: ready.dbPath,
			sessionIds: ["mc-stop-root", "mc-stop-child", "mc-stop-grandchild"],
		});
		expect(
			await fixture.command({
				command: "spawn-child",
				parentId: "mc-stop-child",
				childId: "mc-stop-grandchild",
			}),
		).toEqual({ type: "ack", command: "spawn-child", ok: true });
		expect(
			await fixture.command({
				command: "release",
				handleId: "provider:mc-stop-grandchild",
			}),
		).toEqual({ type: "ack", command: "release", ok: true });
		expect(await fixture.shutdown()).toEqual({
			type: "ack",
			command: "shutdown",
			ok: true,
		});
	});
}
