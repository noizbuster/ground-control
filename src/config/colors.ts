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

const normalizeAgentName = (agentName?: string): string => {
	return (agentName ?? "").trim().toLowerCase();
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
		const normalized = normalizeAgentName(key);

		if (!normalized || !value) {
			continue;
		}

		merged[normalized] = value;
	}

	return merged;
};

const isAgentName = (agentName: string): agentName is AgentName =>
	Object.hasOwn(AGENT_COLOR_MAP, agentName);

export const getAgentColor = (agentName?: string): `#${string}` => {
	const normalized = normalizeAgentName(agentName);
	if (!isAgentName(normalized)) {
		return AGENT_COLOR_MAP.unknown;
	}

	return AGENT_COLOR_MAP[normalized];
};
