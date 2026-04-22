import type { Session, SessionCapabilities, SessionSource } from "../types";

const OPENCODE_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: true,
	hierarchy: true,
};

const CODEX_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: false,
	hierarchy: true,
};

const SESSION_SOURCE_LABELS: Record<SessionSource, string> = {
	opencode: "OpenCode",
	codex: "Codex",
};

const SESSION_SOURCE_COLORS: Record<SessionSource, `#${string}`> = {
	opencode: "#14B8A6",
	codex: "#60A5FA",
};

export const getDefaultSessionCapabilities = (
	source: SessionSource,
): SessionCapabilities => {
	return source === "codex"
		? { ...CODEX_CAPABILITIES }
		: { ...OPENCODE_CAPABILITIES };
};

export const getSessionCapabilities = (
	session?: Pick<Session, "sessionSource" | "capabilities"> | null,
): SessionCapabilities => {
	if (!session) {
		return {
			attach: false,
			delete: false,
			abortChildren: false,
			hierarchy: false,
		};
	}

	return {
		...getDefaultSessionCapabilities(session.sessionSource),
		...(session.capabilities ?? {}),
	};
};

export const getSessionSourceLabel = (source: SessionSource): string => {
	return SESSION_SOURCE_LABELS[source];
};

export const getSessionSourceColor = (source: SessionSource): `#${string}` => {
	return SESSION_SOURCE_COLORS[source];
};

export const canAttachToSession = (
	session?: Pick<Session, "sessionSource" | "capabilities"> | null,
): boolean => {
	return getSessionCapabilities(session).attach;
};

export interface SessionAttachLaunchSpec {
	cmd: string[];
	cwd: string;
}

const sanitizeLaunchDirectory = (
	directory: string | undefined,
	fallbackDirectory: string,
): string => {
	const trimmed = directory?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallbackDirectory;
};

export const getAttachLaunchSpec = (
	session: Pick<Session, "id" | "directory" | "sessionSource" | "capabilities">,
	options?: {
		fallbackDirectory?: string;
		resolveExecutable?: (name: string) => string | undefined;
	},
): SessionAttachLaunchSpec | null => {
	if (!canAttachToSession(session)) {
		return null;
	}

	const fallbackDirectory = options?.fallbackDirectory ?? process.cwd();
	const resolveExecutable =
		options?.resolveExecutable ?? ((name: string) => Bun.which(name) ?? name);
	const resolveCommand = (name: string): string =>
		resolveExecutable(name) ?? name;
	const cwd = sanitizeLaunchDirectory(session.directory, fallbackDirectory);

	if (session.sessionSource === "codex") {
		return {
			cmd: [resolveCommand("codex"), "resume", session.id],
			cwd,
		};
	}

	return {
		cmd: [resolveCommand("opencode"), "--session", session.id],
		cwd,
	};
};

export const canDeleteSession = (
	session?: Pick<Session, "sessionSource" | "capabilities"> | null,
): boolean => {
	return getSessionCapabilities(session).delete;
};

export const canAbortSessionChildren = (
	session?: Pick<Session, "sessionSource" | "capabilities"> | null,
): boolean => {
	return getSessionCapabilities(session).abortChildren;
};

export const getSessionCapabilitySummary = (
	session?: Pick<Session, "sessionSource" | "capabilities"> | null,
): string => {
	if (!session) {
		return "Unavailable";
	}

	const capabilities = getSessionCapabilities(session);
	const labels: string[] = [];

	if (capabilities.attach) {
		labels.push("attach");
	}

	if (capabilities.delete) {
		labels.push("delete");
	}

	if (capabilities.abortChildren) {
		labels.push("abort child sessions");
	}

	if (capabilities.hierarchy) {
		labels.push("hierarchy");
	}

	return labels.length > 0 ? labels.join(", ") : "inspect only";
};

export const countSessionsBySource = (
	sessions: Array<Pick<Session, "sessionSource">>,
): Partial<Record<SessionSource, number>> => {
	return sessions.reduce<Partial<Record<SessionSource, number>>>(
		(counts, session) => {
			counts[session.sessionSource] = (counts[session.sessionSource] ?? 0) + 1;
			return counts;
		},
		{},
	);
};
