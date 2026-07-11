import type { SessionSource } from "../types";
import type { MissionControlFallbackPlan } from "./missionControlFallbackPlan";

export type KillFallbackRoute =
	| "mission-control"
	| "stale-mission-control"
	| "codex"
	| "opencode";

export const resolveKillFallbackRoute = (
	missionControlPlan: MissionControlFallbackPlan | null,
	rootSource: SessionSource | undefined,
): KillFallbackRoute => {
	if (missionControlPlan) return "mission-control";
	if (rootSource === "mission-control") return "stale-mission-control";
	if (rootSource === "codex") return "codex";
	return "opencode";
};
