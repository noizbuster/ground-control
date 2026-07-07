import { statSync } from "node:fs";
import { delimiter, dirname, isAbsolute } from "node:path";
import type { Session, SessionCapabilities, SessionSource } from "../types";
import { which } from "./which";

const OPENCODE_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: true,
	hierarchy: true,
};

const CODEX_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: true,
	hierarchy: true,
};

const CLAUDE_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: false,
	hierarchy: true,
};

const PI_FAMILY_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: false,
	hierarchy: true,
};

const MISSION_CONTROL_CAPABILITIES: SessionCapabilities = {
	attach: true,
	delete: true,
	abortChildren: false,
	hierarchy: true,
};

const SESSION_SOURCE_LABELS: Record<SessionSource, string> = {
	opencode: "OpenCode",
	codex: "Codex",
	claude: "Claude Code",
	pi: "Pi",
	omp: "omp",
	"mission-control": "Mission Control",
};

const SESSION_SOURCE_COLORS: Record<SessionSource, `#${string}`> = {
	opencode: "#14B8A6",
	codex: "#60A5FA",
	claude: "#D97706",
	pi: "#A78BFA",
	omp: "#F472B6",
	"mission-control": "#22D3EE",
};

export const getDefaultSessionCapabilities = (
	source: SessionSource,
): SessionCapabilities => {
	switch (source) {
		case "opencode":
			return { ...OPENCODE_CAPABILITIES };
		case "codex":
			return { ...CODEX_CAPABILITIES };
		case "claude":
			return { ...CLAUDE_CAPABILITIES };
		case "pi":
		case "omp":
			return { ...PI_FAMILY_CAPABILITIES };
		case "mission-control":
			return { ...MISSION_CONTROL_CAPABILITIES };
	}
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

export const getAttachLaunchEnvironment = (
	attachLaunchSpec: SessionAttachLaunchSpec,
	baseEnvironment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> => {
	const executablePath = attachLaunchSpec.cmd[0];
	const executableDirectory = isAbsolute(executablePath)
		? dirname(executablePath)
		: null;

	return {
		...baseEnvironment,
		PATH: [executableDirectory, baseEnvironment.PATH]
			.filter((entry): entry is string => Boolean(entry))
			.join(delimiter),
	};
};

const sanitizeLaunchDirectory = (
	directory: string | undefined,
	fallbackDirectory: string,
): string => {
	const trimmed = directory?.trim();
	if (!trimmed || trimmed.length === 0) {
		return fallbackDirectory;
	}

	try {
		return statSync(trimmed).isDirectory() ? trimmed : fallbackDirectory;
	} catch {
		return fallbackDirectory;
	}
};

const getClaudeAttachSessionId = (sessionId: string): string => {
	const separatorIndex = sessionId.indexOf(":");
	return separatorIndex > 0 ? sessionId.slice(0, separatorIndex) : sessionId;
};

const getPiAttachTarget = (
	session: Pick<Session, "id" | "parent_id" | "sourceMetadata">,
): string => {
	if (!session.parent_id) {
		return session.id;
	}

	return session.sourceMetadata?.sessionPath ?? session.id;
};

const getOmpAttachTarget = (
	session: Pick<Session, "id" | "sourceMetadata">,
): string => session.sourceMetadata?.sessionPath ?? session.id;

export const getAttachLaunchSpec = (
	session: Pick<
		Session,
		| "id"
		| "parent_id"
		| "directory"
		| "sessionSource"
		| "capabilities"
		| "sourceMetadata"
	>,
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
		options?.resolveExecutable ?? ((name: string) => which(name) ?? undefined);
	const resolveCommand = (name: string): string =>
		resolveExecutable(name) ?? name;
	const cwd = sanitizeLaunchDirectory(session.directory, fallbackDirectory);

	if (session.sessionSource === "opencode") {
		return {
			cmd: [resolveCommand("opencode"), "--session", session.id],
			cwd,
		};
	}

	if (session.sessionSource === "codex") {
		return {
			cmd: [resolveCommand("codex"), "resume", session.id],
			cwd,
		};
	}

	if (session.sessionSource === "claude") {
		return {
			cmd: [
				resolveCommand("claude"),
				"--resume",
				getClaudeAttachSessionId(session.id),
			],
			cwd,
		};
	}

	if (session.sessionSource === "pi") {
		return {
			cmd: [resolveCommand("pi"), "--session", getPiAttachTarget(session)],
			cwd,
		};
	}

	if (session.sessionSource === "omp") {
		return {
			cmd: [resolveCommand("omp"), "--resume", getOmpAttachTarget(session)],
			cwd,
		};
	}

	if (session.sessionSource === "mission-control") {
		const resolvedExecutable =
			resolveExecutable("mc") ?? resolveExecutable("mctrl") ?? "mctrl";
		return {
			cmd: [resolvedExecutable, "--session", session.id],
			cwd,
		};
	}

	return null;
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
