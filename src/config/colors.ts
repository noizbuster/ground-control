type AgentName =
	| "atlas"
	| "build"
	| "explore"
	| "hephaestus"
	| "librarian"
	| "metis"
	| "momus"
	| "oracle"
	| "quick"
	| "prometheus"
	| "sisyphus"
	| "sisyphus-junior"
	| "unknown";

export type AgentColorOverrides = Partial<Record<string, `#${string}`>>;

const AGENT_DISPLAY_NAME_MAP: Readonly<Record<AgentName, string>> = {
	atlas: "Atlas",
	build: "Build",
	explore: "Explore",
	hephaestus: "Hephaestus",
	librarian: "Librarian",
	metis: "Metis",
	momus: "Momus",
	oracle: "Oracle",
	quick: "Quick",
	prometheus: "Prometheus",
	sisyphus: "Sisyphus",
	"sisyphus-junior": "Sisyphus-Junior",
	unknown: "Unknown",
};

const stripAgentSuffix = (agentName?: string): string => {
	return (agentName ?? "").replace(/\s*\([^)]*\)\s*$/u, "").trim();
};

const normalizeAgentLookup = (agentName?: string): string => {
	return stripAgentSuffix(agentName)
		.toLowerCase()
		.replace(/[_\s]+/gu, "-")
		.replace(/-+/gu, "-")
		.trim();
};

export const AGENT_COLOR_MAP: Readonly<Record<AgentName, `#${string}`>> = {
	sisyphus: "#00CED1",
	hephaestus: "#D97706",
	atlas: "#10B981",
	"sisyphus-junior": "#20B2AA",
	prometheus: "#FF5722",
	oracle: "#9333EA",
	metis: "#06B6D4",
	momus: "#EF4444",
	build: "#3B82F6",
	explore: "#22C55E",
	librarian: "#A855F7",
	quick: "#F59E0B",
	unknown: "#888888",
};

export const createAgentColorMap = (
	overrides?: AgentColorOverrides,
): Record<string, `#${string}`> => {
	const merged: Record<string, `#${string}`> = { ...AGENT_COLOR_MAP };

	if (!overrides) {
		return merged;
	}

	for (const [key, value] of Object.entries(overrides)) {
		const normalized = normalizeAgentLookup(key);

		if (!normalized || !value) {
			continue;
		}

		merged[normalized] = value;
	}

	return merged;
};

export const mergeAgentColorOverrides = createAgentColorMap;

const isAgentName = (agentName: string): agentName is AgentName =>
	Object.hasOwn(AGENT_COLOR_MAP, agentName);

export const getCanonicalAgentName = (agentName?: string): AgentName => {
	const normalized = normalizeAgentLookup(agentName);
	if (!isAgentName(normalized)) {
		return "unknown";
	}

	return normalized;
};

export const getAgentDisplayName = (agentName?: string): string => {
	const canonical = getCanonicalAgentName(agentName);
	if (canonical !== "unknown") {
		return AGENT_DISPLAY_NAME_MAP[canonical];
	}

	const stripped = stripAgentSuffix(agentName);
	return stripped.length > 0 ? stripped : AGENT_DISPLAY_NAME_MAP.unknown;
};

export const getAgentColor = (agentName?: string): `#${string}` => {
	const canonical = getCanonicalAgentName(agentName);
	return AGENT_COLOR_MAP[canonical];
};
