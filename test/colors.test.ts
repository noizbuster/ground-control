import { describe, expect, it } from "vitest";
import {
	AGENT_COLOR_MAP,
	getAgentColor,
	getAgentDisplayName,
	getCanonicalAgentName,
} from "../src/config/colors";

describe("agent name normalization", () => {
	it("ignores zero-width spaces in canonical agent lookups", () => {
		expect(getCanonicalAgentName("sisy\u200Bphus")).toBe("sisyphus");
		expect(getCanonicalAgentName("sisyphus\u200B-junior")).toBe(
			"sisyphus-junior",
		);
	});

	it("keeps display names clean when agent names contain zero-width spaces", () => {
		expect(getAgentDisplayName("sisyphus\u200B-junior")).toBe(
			"Sisyphus-Junior",
		);
		expect(getAgentDisplayName("sisyphus\u200B-junior (worker 2)")).toBe(
			"Sisyphus-Junior",
		);
	});

	it("keeps known agent colors stable when names contain zero-width spaces", () => {
		expect(getAgentColor("sisyphus\u200B-junior")).toBe(
			AGENT_COLOR_MAP["sisyphus-junior"],
		);
	});

	it("strips zero-width spaces from unknown display names too", () => {
		expect(getAgentDisplayName("custom\u200Bagent")).toBe("customagent");
	});

	it("maps observed dash-suffixed agent aliases back to canonical names", () => {
		expect(getCanonicalAgentName("Metis - Plan Consultant")).toBe("metis");
		expect(getCanonicalAgentName("\u200BSisyphus - Ultraworker")).toBe(
			"sisyphus",
		);
		expect(getCanonicalAgentName("\u200B\u200BHephaestus - Deep Agent")).toBe(
			"hephaestus",
		);
	});

	it("keeps colors and display names for observed dash-suffixed aliases", () => {
		expect(getAgentDisplayName("Metis - Plan Consultant")).toBe("Metis");
		expect(getAgentColor("Metis - Plan Consultant")).toBe(
			AGENT_COLOR_MAP.metis,
		);
		expect(getAgentDisplayName("\u200BSisyphus - Ultraworker")).toBe(
			"Sisyphus",
		);
		expect(getAgentColor("\u200BSisyphus - Ultraworker")).toBe(
			AGENT_COLOR_MAP.sisyphus,
		);
	});

	it("maps compaction to the dedicated muted opencode-style color", () => {
		expect(getCanonicalAgentName("compaction")).toBe("compaction");
		expect(getAgentDisplayName("compaction")).toBe("Compaction");
		expect(getAgentColor("compaction")).toBe("#6C6C6C");
	});
});
