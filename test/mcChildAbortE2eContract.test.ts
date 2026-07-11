import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const runnerPath = join(root, "scripts", "run-mc-child-abort-e2e.mjs");
const workflowPath = join(
	root,
	".github",
	"workflows",
	"mc-child-abort-e2e.yml",
);

describe("Mission Control child-abort E2E runner contract", () => {
	it("uses one shell-free runner for POSIX and PowerShell entry paths", () => {
		const source = readFileSync(runnerPath, "utf8");
		expect(source).toContain("spawn(");
		expect(source).toContain("shell: false");
		expect(source).not.toMatch(/exec(?:File|Sync)?\s*\(/u);
		expect(source).toContain(
			"mission-control-sidecar$" +
				'{process.platform === "win32" ? ".exe" : ""}',
		);
		expect(source).toContain("test/missionControlChildAbort.e2e.test.ts");
		expect(source).toContain("MC_CLI_ENTRY");
		expect(source).toContain("MC_NATIVE_SIDECAR");
	});

	it("pins separate repository checkouts and validates both refs as 40-hex", () => {
		const workflow = readFileSync(workflowPath, "utf8");
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toMatch(/mc_ref:[\s\S]*required:\s*true/u);
		expect(workflow).toMatch(/gc_ref:[\s\S]*required:\s*true/u);
		expect(workflow).toContain("^[0-9a-f]{40}$");
		expect(workflow).toContain("repository: noizbuster/mission-control");
		expect(workflow).toContain("repository: noizbuster/ground-control");
		expect(workflow).toContain("ref: $" + "{{ inputs.mc_ref }}");
		expect(workflow).toContain("ref: $" + "{{ inputs.gc_ref }}");
		expect(workflow).not.toMatch(/ref:\s*(?:main|master|dev|HEAD)\s*$/mu);
	});
});
