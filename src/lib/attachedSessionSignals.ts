import type { SessionSource } from "../types";

export interface ExternalAttachedSignals {
	sessionIds: Set<string>;
	directoryProcessCounts: Map<string, number>;
}

const ATTACHED_SESSION_ID_PATTERN =
	/--session(?:=|\s+)(["']?)([A-Za-z0-9._:-]+)\1/u;
const CODEX_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const OPENCODE_COMMAND_NAME = "opencode";
const OPENCODE_WRAPPED_BASENAMES = new Set(["opencode"]);
const NON_SESSION_OPENCODE_SUBCOMMANDS = new Set([
	"completion",
	"acp",
	"mcp",
	"attach",
	"run",
	"debug",
	"providers",
	"auth",
	"agent",
	"upgrade",
	"uninstall",
	"serve",
	"web",
	"models",
	"stats",
	"export",
	"import",
	"github",
	"pr",
	"session",
	"db",
	"x",
]);

const CODEX_COMMAND_NAME = "codex";
const INTERNAL_CODEX_VENDOR_PATH_MARKER = "/vendor/";
const NON_SESSION_CODEX_SUBCOMMANDS = new Set([
	"exec",
	"review",
	"login",
	"logout",
	"mcp",
	"plugin",
	"mcp-server",
	"app-server",
	"completion",
	"sandbox",
	"debug",
	"apply",
	"cloud",
	"exec-server",
	"features",
	"help",
]);
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "-v", "--version"]);

const CLAUDE_COMMAND_NAME = "claude";
const CLAUDE_WRAPPED_BASENAMES = new Set(["claude"]);
const NON_SESSION_CLAUDE_SUBCOMMANDS = new Set([
	"update",
	"auth",
	"agents",
	"auto-mode",
	"mcp",
	"plugin",
	"plugins",
	"remote-control",
	"setup-token",
]);

const PI_COMMAND_NAME = "pi";
const OMP_COMMAND_NAME = "omp";
const PI_FAMILY_COMMAND_NAMES = new Set([PI_COMMAND_NAME, OMP_COMMAND_NAME]);
const NON_SESSION_PI_FAMILY_SUBCOMMANDS = new Set([
	"help",
	"completion",
	"config",
	"auth",
	"login",
	"logout",
	"mcp",
	"admin",
	"package",
	"packages",
	"export",
	"rpc",
	"acp",
]);

const MCTRL_COMMAND_NAME = "mctrl";
const MISSION_CONTROL_COMMAND_NAMES = new Set([
	MCTRL_COMMAND_NAME,
	"mission-control-sidecar",
]);
const NON_SESSION_MCTRL_SUBCOMMANDS = new Set([
	"session",
	"auth",
	"models",
	"mcp",
	"agents",
	"graph",
	"help",
	"completion",
	"version",
]);

const getBasename = (value: string): string => {
	return value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
};

const normalizeCommandToken = (token: string): string => {
	return token
		.trim()
		.replace(/^["']+/u, "")
		.replace(/["']+$/u, "");
};

const isRuntimeWrapperCommand = (commandBasename: string): boolean => {
	return (
		commandBasename === "node" ||
		commandBasename === "bun" ||
		commandBasename === "deno"
	);
};

const isOpencodeToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	if (normalizedToken.length === 0) {
		return false;
	}

	return OPENCODE_WRAPPED_BASENAMES.has(getBasename(normalizedToken));
};

const containsOpencodeToken = (tokens: readonly string[]): boolean => {
	return tokens.some((token) => isOpencodeToken(token));
};

const getOpencodeExecutableTokenIndex = (
	commandBasename: string,
	argumentTokens: readonly string[],
): number => {
	const tokenIndex = argumentTokens.findIndex((token) =>
		isOpencodeToken(token),
	);
	if (tokenIndex >= 0) {
		return tokenIndex;
	}

	return commandBasename === OPENCODE_COMMAND_NAME ? 0 : -1;
};

const isDirectOpencodeCommand = (
	commandBasename: string,
	firstArgumentBasename: string,
): boolean => {
	return (
		commandBasename === OPENCODE_COMMAND_NAME ||
		firstArgumentBasename === OPENCODE_COMMAND_NAME
	);
};

const isRuntimeWrappedOpencodeCommand = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	return (
		isRuntimeWrapperCommand(commandBasename) &&
		argumentTokens.length >= 2 &&
		OPENCODE_WRAPPED_BASENAMES.has(
			getBasename(normalizeCommandToken(argumentTokens[1])),
		)
	);
};

const isNonSessionOpencodeInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const executableTokenIndex = getOpencodeExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return false;
	}

	let hasOnlyHelpOrVersionFlag = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (HELP_OR_VERSION_FLAGS.has(normalizedToken)) {
			hasOnlyHelpOrVersionFlag = true;
			continue;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		const subcommandCandidate = getBasename(normalizedToken);
		return NON_SESSION_OPENCODE_SUBCOMMANDS.has(subcommandCandidate);
	}

	return hasOnlyHelpOrVersionFlag;
};

const isClaudeToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	if (normalizedToken.length === 0) {
		return false;
	}

	return CLAUDE_WRAPPED_BASENAMES.has(getBasename(normalizedToken));
};

const containsClaudeToken = (tokens: readonly string[]): boolean => {
	return tokens.some((token) => isClaudeToken(token));
};

const getClaudeExecutableTokenIndex = (
	commandBasename: string,
	argumentTokens: readonly string[],
): number => {
	const tokenIndex = argumentTokens.findIndex((token) => isClaudeToken(token));
	if (tokenIndex >= 0) {
		return tokenIndex;
	}

	return commandBasename === CLAUDE_COMMAND_NAME ? 0 : -1;
};

const isDirectClaudeCommand = (
	commandBasename: string,
	firstArgumentBasename: string,
): boolean => {
	return (
		commandBasename === CLAUDE_COMMAND_NAME ||
		firstArgumentBasename === CLAUDE_COMMAND_NAME
	);
};

const isRuntimeWrappedClaudeCommand = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	return (
		isRuntimeWrapperCommand(commandBasename) &&
		argumentTokens.length >= 2 &&
		CLAUDE_WRAPPED_BASENAMES.has(
			getBasename(normalizeCommandToken(argumentTokens[1])),
		)
	);
};

const getFirstClaudePositionalToken = (
	commandBasename: string,
	argumentTokens: readonly string[],
): string | undefined => {
	const executableTokenIndex = getClaudeExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return undefined;
	}

	let hasPendingFlagValue = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (hasPendingFlagValue) {
			hasPendingFlagValue = false;
			continue;
		}

		if (
			normalizedToken === "--add-dir" ||
			normalizedToken === "--agent" ||
			normalizedToken === "--append-system-prompt" ||
			normalizedToken === "--mcp-config" ||
			normalizedToken === "-m" ||
			normalizedToken === "--model" ||
			normalizedToken === "--output-format" ||
			normalizedToken === "--permission-mode" ||
			normalizedToken === "--permission-prompt-tool" ||
			normalizedToken === "-p" ||
			normalizedToken === "--print" ||
			normalizedToken === "-r" ||
			normalizedToken === "--resume" ||
			normalizedToken === "--session-id" ||
			normalizedToken === "--settings" ||
			normalizedToken === "--system-prompt"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (
			normalizedToken === "-c" ||
			normalizedToken === "--continue" ||
			HELP_OR_VERSION_FLAGS.has(normalizedToken)
		) {
			continue;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		return normalizedToken;
	}

	return undefined;
};

const isClaudeSessionBearingInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const executableTokenIndex = getClaudeExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return false;
	}

	const firstPositionalToken = getFirstClaudePositionalToken(
		commandBasename,
		argumentTokens,
	);
	if (!firstPositionalToken) {
		return true;
	}

	return !NON_SESSION_CLAUDE_SUBCOMMANDS.has(getBasename(firstPositionalToken));
};

const hasClaudePrintFlag = (argumentTokens: readonly string[]): boolean => {
	return argumentTokens.some((token) => {
		const normalizedToken = normalizeCommandToken(token);
		return (
			normalizedToken === "-p" ||
			normalizedToken === "--print" ||
			normalizedToken.startsWith("--print=")
		);
	});
};

const tryReadClaudeSessionId = (
	commandBasename: string,
	argumentTokens: readonly string[],
): string | undefined => {
	const executableTokenIndex = getClaudeExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return undefined;
	}

	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (
			normalizedToken === "-r" ||
			normalizedToken === "--resume" ||
			normalizedToken === "--session-id"
		) {
			const nextToken = normalizeCommandToken(
				argumentTokens[tokenIndex + 1] ?? "",
			);
			return nextToken || undefined;
		}

		if (normalizedToken.startsWith("--resume=")) {
			return normalizeCommandToken(normalizedToken.slice("--resume=".length));
		}

		if (normalizedToken.startsWith("--session-id=")) {
			return normalizeCommandToken(
				normalizedToken.slice("--session-id=".length),
			);
		}
	}

	return undefined;
};

const isCodexToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	if (normalizedToken.length === 0) {
		return false;
	}

	return getBasename(normalizedToken) === CODEX_COMMAND_NAME;
};

const isInternalCodexVendorProcess = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	if (commandBasename !== CODEX_COMMAND_NAME || argumentTokens.length === 0) {
		return false;
	}

	const executableToken = normalizeCommandToken(argumentTokens[0]);
	return (
		getBasename(executableToken) === CODEX_COMMAND_NAME &&
		executableToken.includes(INTERNAL_CODEX_VENDOR_PATH_MARKER)
	);
};

const containsCodexToken = (tokens: readonly string[]): boolean => {
	return tokens.some((token) => isCodexToken(token));
};

const getCodexExecutableTokenIndex = (
	commandBasename: string,
	argumentTokens: readonly string[],
): number => {
	const tokenIndex = argumentTokens.findIndex((token) => isCodexToken(token));
	if (tokenIndex >= 0) {
		return tokenIndex;
	}

	return commandBasename === CODEX_COMMAND_NAME ? 0 : -1;
};

const isDirectCodexCommand = (
	commandBasename: string,
	firstArgumentBasename: string,
): boolean => {
	return (
		commandBasename === CODEX_COMMAND_NAME ||
		firstArgumentBasename === CODEX_COMMAND_NAME
	);
};

const isRuntimeWrappedCodexCommand = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	return (
		isRuntimeWrapperCommand(commandBasename) &&
		argumentTokens.length >= 2 &&
		getBasename(normalizeCommandToken(argumentTokens[1])) === CODEX_COMMAND_NAME
	);
};

const getFirstCodexPositionalToken = (
	commandBasename: string,
	argumentTokens: readonly string[],
): string | undefined => {
	const executableTokenIndex = getCodexExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return undefined;
	}

	let hasPendingFlagValue = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (hasPendingFlagValue) {
			hasPendingFlagValue = false;
			continue;
		}

		if (
			normalizedToken === "-c" ||
			normalizedToken === "--config" ||
			normalizedToken === "-m" ||
			normalizedToken === "--model" ||
			normalizedToken === "-p" ||
			normalizedToken === "--profile" ||
			normalizedToken === "-s" ||
			normalizedToken === "--sandbox" ||
			normalizedToken === "-a" ||
			normalizedToken === "--ask-for-approval" ||
			normalizedToken === "-C" ||
			normalizedToken === "--cd" ||
			normalizedToken === "--remote" ||
			normalizedToken === "--remote-auth-token-env" ||
			normalizedToken === "--local-provider"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (
			normalizedToken === "--enable" ||
			normalizedToken === "--disable" ||
			normalizedToken === "--add-dir" ||
			normalizedToken === "-i" ||
			normalizedToken === "--image"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		return normalizedToken;
	}

	return undefined;
};

const isCodexSessionBearingInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const firstPositionalToken = getFirstCodexPositionalToken(
		commandBasename,
		argumentTokens,
	);
	if (!firstPositionalToken) {
		return true;
	}

	const subcommand = getBasename(firstPositionalToken);
	if (subcommand === "resume" || subcommand === "fork") {
		return true;
	}

	return !NON_SESSION_CODEX_SUBCOMMANDS.has(subcommand);
};

const tryReadCodexSessionId = (
	commandBasename: string,
	argumentTokens: readonly string[],
): string | undefined => {
	const firstPositionalToken = getFirstCodexPositionalToken(
		commandBasename,
		argumentTokens,
	);
	if (!firstPositionalToken) {
		return undefined;
	}

	const subcommand = getBasename(firstPositionalToken);
	if (subcommand !== "resume" && subcommand !== "fork") {
		return undefined;
	}

	const executableTokenIndex = getCodexExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return undefined;
	}

	let hasPendingFlagValue = false;
	let passedSubcommand = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (!passedSubcommand) {
			if (getBasename(normalizedToken) === subcommand) {
				passedSubcommand = true;
			}
			continue;
		}

		if (hasPendingFlagValue) {
			hasPendingFlagValue = false;
			continue;
		}

		if (
			normalizedToken === "-c" ||
			normalizedToken === "--config" ||
			normalizedToken === "-m" ||
			normalizedToken === "--model" ||
			normalizedToken === "-p" ||
			normalizedToken === "--profile" ||
			normalizedToken === "-s" ||
			normalizedToken === "--sandbox" ||
			normalizedToken === "-a" ||
			normalizedToken === "--ask-for-approval" ||
			normalizedToken === "-C" ||
			normalizedToken === "--cd" ||
			normalizedToken === "--remote" ||
			normalizedToken === "--remote-auth-token-env" ||
			normalizedToken === "--local-provider"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (
			normalizedToken === "--enable" ||
			normalizedToken === "--disable" ||
			normalizedToken === "--add-dir" ||
			normalizedToken === "-i" ||
			normalizedToken === "--image"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		return CODEX_SESSION_ID_PATTERN.test(normalizedToken)
			? normalizedToken
			: undefined;
	}

	return undefined;
};

const isPiFamilyToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	return PI_FAMILY_COMMAND_NAMES.has(getBasename(normalizedToken));
};

const containsPiFamilyToken = (tokens: readonly string[]): boolean => {
	return tokens.some((token) => isPiFamilyToken(token));
};

const getPiFamilyExecutableTokenIndex = (
	commandBasename: string,
	argumentTokens: readonly string[],
): number => {
	const tokenIndex = argumentTokens.findIndex((token) =>
		isPiFamilyToken(token),
	);
	if (tokenIndex >= 0) {
		return tokenIndex;
	}

	return PI_FAMILY_COMMAND_NAMES.has(commandBasename) ? 0 : -1;
};

const getPiFamilyCommandName = (
	commandBasename: string,
	argumentTokens: readonly string[],
): typeof PI_COMMAND_NAME | typeof OMP_COMMAND_NAME | undefined => {
	const executableTokenIndex = getPiFamilyExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return undefined;
	}

	const token =
		argumentTokens[executableTokenIndex] ??
		(PI_FAMILY_COMMAND_NAMES.has(commandBasename) ? commandBasename : "");
	const basename = getBasename(normalizeCommandToken(token)) || commandBasename;
	return basename === OMP_COMMAND_NAME ? OMP_COMMAND_NAME : PI_COMMAND_NAME;
};

const isDirectPiFamilyCommand = (
	commandBasename: string,
	firstArgumentBasename: string,
): boolean => {
	return (
		PI_FAMILY_COMMAND_NAMES.has(commandBasename) ||
		PI_FAMILY_COMMAND_NAMES.has(firstArgumentBasename)
	);
};

const isRuntimeWrappedPiFamilyCommand = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	return (
		isRuntimeWrapperCommand(commandBasename) &&
		argumentTokens.length >= 2 &&
		isPiFamilyToken(argumentTokens[1])
	);
};

const looksLikePathSessionReference = (value: string): boolean =>
	value.includes("/") || value.includes("\\\\") || value.endsWith(".jsonl");

const tryReadPiFamilySessionId = (
	commandBasename: string,
	argumentTokens: readonly string[],
): string | undefined => {
	const executableTokenIndex = getPiFamilyExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	const commandName = getPiFamilyCommandName(commandBasename, argumentTokens);
	if (executableTokenIndex < 0 || !commandName) {
		return undefined;
	}

	const sessionFlags =
		commandName === OMP_COMMAND_NAME
			? new Set(["--resume", "-r", "--session"])
			: new Set(["--session", "--session-id"]);
	const sessionFlagPrefixes =
		commandName === OMP_COMMAND_NAME
			? ["--resume=", "--session="]
			: ["--session=", "--session-id="];

	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (sessionFlags.has(normalizedToken)) {
			const nextToken = normalizeCommandToken(
				argumentTokens[tokenIndex + 1] ?? "",
			);
			return nextToken && !looksLikePathSessionReference(nextToken)
				? nextToken
				: undefined;
		}

		for (const prefix of sessionFlagPrefixes) {
			if (normalizedToken.startsWith(prefix)) {
				const value = normalizeCommandToken(
					normalizedToken.slice(prefix.length),
				);
				return value && !looksLikePathSessionReference(value)
					? value
					: undefined;
			}
		}
	}

	return undefined;
};

const isPiFamilyPrintOrMachineMode = (
	argumentTokens: readonly string[],
): boolean => {
	return argumentTokens.some((token) => {
		const normalizedToken = normalizeCommandToken(token);
		return (
			normalizedToken === "-p" ||
			normalizedToken === "--print" ||
			normalizedToken.startsWith("--print=") ||
			normalizedToken === "--json" ||
			normalizedToken === "--rpc" ||
			normalizedToken === "--acp" ||
			normalizedToken === "--export" ||
			normalizedToken.startsWith("--json=") ||
			normalizedToken.startsWith("--rpc=") ||
			normalizedToken.startsWith("--acp=")
		);
	});
};

const isPiFamilySessionBearingInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const executableTokenIndex = getPiFamilyExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return false;
	}

	let hasPendingFlagValue = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (hasPendingFlagValue) {
			hasPendingFlagValue = false;
			continue;
		}

		if (
			normalizedToken === "--session" ||
			normalizedToken === "--session-id" ||
			normalizedToken === "--resume" ||
			normalizedToken === "-r" ||
			normalizedToken === "--session-dir" ||
			normalizedToken === "-c" ||
			normalizedToken === "--config" ||
			normalizedToken === "-m" ||
			normalizedToken === "--model" ||
			normalizedToken === "--provider"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (HELP_OR_VERSION_FLAGS.has(normalizedToken)) {
			return false;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		return !NON_SESSION_PI_FAMILY_SUBCOMMANDS.has(getBasename(normalizedToken));
	}

	return true;
};

const isMctrlToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	if (normalizedToken.length === 0) {
		return false;
	}

	return MISSION_CONTROL_COMMAND_NAMES.has(getBasename(normalizedToken));
};

const containsMctrlToken = (tokens: readonly string[]): boolean => {
	return tokens.some((token) => isMctrlToken(token));
};

const getMctrlExecutableTokenIndex = (
	commandBasename: string,
	argumentTokens: readonly string[],
): number => {
	const tokenIndex = argumentTokens.findIndex((token) => isMctrlToken(token));
	if (tokenIndex >= 0) {
		return tokenIndex;
	}

	return MISSION_CONTROL_COMMAND_NAMES.has(commandBasename) ? 0 : -1;
};

const isDirectMctrlCommand = (
	commandBasename: string,
	firstArgumentBasename: string,
): boolean => {
	return (
		MISSION_CONTROL_COMMAND_NAMES.has(commandBasename) ||
		MISSION_CONTROL_COMMAND_NAMES.has(firstArgumentBasename)
	);
};

const isRuntimeWrappedMctrlCommand = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	return (
		isRuntimeWrapperCommand(commandBasename) &&
		argumentTokens.length >= 2 &&
		isMctrlToken(argumentTokens[1])
	);
};

const isNonSessionMctrlInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const executableTokenIndex = getMctrlExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return false;
	}

	let hasOnlyHelpOrVersionFlag = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (HELP_OR_VERSION_FLAGS.has(normalizedToken)) {
			hasOnlyHelpOrVersionFlag = true;
			continue;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		const subcommandCandidate = getBasename(normalizedToken);
		return NON_SESSION_MCTRL_SUBCOMMANDS.has(subcommandCandidate);
	}

	return hasOnlyHelpOrVersionFlag;
};

const isMctrlSessionBearingInvocation = (
	commandBasename: string,
	argumentTokens: readonly string[],
): boolean => {
	const executableTokenIndex = getMctrlExecutableTokenIndex(
		commandBasename,
		argumentTokens,
	);
	if (executableTokenIndex < 0) {
		return false;
	}

	let hasPendingFlagValue = false;
	for (
		let tokenIndex = executableTokenIndex + 1;
		tokenIndex < argumentTokens.length;
		tokenIndex += 1
	) {
		const normalizedToken = normalizeCommandToken(argumentTokens[tokenIndex]);
		if (!normalizedToken || normalizedToken === "--") {
			continue;
		}

		if (hasPendingFlagValue) {
			hasPendingFlagValue = false;
			continue;
		}

		if (
			normalizedToken === "--session" ||
			normalizedToken === "--config" ||
			normalizedToken === "-c" ||
			normalizedToken === "--model" ||
			normalizedToken === "-m" ||
			normalizedToken === "--provider"
		) {
			hasPendingFlagValue = true;
			continue;
		}

		if (HELP_OR_VERSION_FLAGS.has(normalizedToken)) {
			return false;
		}

		if (normalizedToken.startsWith("-")) {
			continue;
		}

		return !NON_SESSION_MCTRL_SUBCOMMANDS.has(getBasename(normalizedToken));
	}

	return true;
};

export const getExternalAttachedDirectoryKey = (
	source: SessionSource,
	directory: string,
): string => {
	if (source === "pi" || source === "omp") {
		return `${source}:${directory}`;
	}

	if (source === "mission-control") {
		return `mission-control:${directory}`;
	}

	return directory;
};

const incrementDirectoryProcessCount = (
	directoryProcessCounts: Map<string, number>,
	directoryKey: string,
): void => {
	const existingCount = directoryProcessCounts.get(directoryKey) ?? 0;
	directoryProcessCounts.set(directoryKey, existingCount + 1);
};

export const parseAttachedSessionIdsFromProcessList = (
	processListOutput: string,
	readProcessCwd: (pid: number) => string | null,
): ExternalAttachedSignals => {
	const externalAttachedSignals: ExternalAttachedSignals = {
		sessionIds: new Set<string>(),
		directoryProcessCounts: new Map<string, number>(),
	};

	for (const line of processListOutput.split(/\r?\n/u)) {
		const trimmedLine = line.trim();
		if (!trimmedLine || trimmedLine.startsWith("PID")) {
			continue;
		}

		const processRowMatch = trimmedLine.match(/^(\d+)\s+(\S+)\s+(.+)$/u);
		if (!processRowMatch) {
			continue;
		}

		const pid = Number.parseInt(processRowMatch[1], 10);
		if (!Number.isInteger(pid) || pid <= 0) {
			continue;
		}

		const commandName = processRowMatch[2];
		const commandLine = processRowMatch[3];
		const commandBasename = getBasename(commandName);
		const argumentTokens = commandLine.split(/\s+/u).filter(Boolean);
		if (argumentTokens.length === 0) {
			continue;
		}

		const firstArgumentBasename = getBasename(
			normalizeCommandToken(argumentTokens[0]),
		);

		const isOpencodeInvocation =
			isDirectOpencodeCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedOpencodeCommand(commandBasename, argumentTokens) ||
			containsOpencodeToken(argumentTokens);
		if (isOpencodeInvocation) {
			const attachedSessionIdMatch = commandLine.match(
				ATTACHED_SESSION_ID_PATTERN,
			);
			if (attachedSessionIdMatch) {
				externalAttachedSignals.sessionIds.add(attachedSessionIdMatch[2]);
				continue;
			}

			if (isNonSessionOpencodeInvocation(commandBasename, argumentTokens)) {
				continue;
			}

			const processCwd = readProcessCwd(pid);
			if (!processCwd) {
				continue;
			}

			const directoryKey = getExternalAttachedDirectoryKey(
				"opencode",
				processCwd,
			);
			incrementDirectoryProcessCount(
				externalAttachedSignals.directoryProcessCounts,
				directoryKey,
			);
			continue;
		}

		const isCodexInvocation =
			isDirectCodexCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedCodexCommand(commandBasename, argumentTokens) ||
			containsCodexToken(argumentTokens);
		if (isCodexInvocation) {
			if (isInternalCodexVendorProcess(commandBasename, argumentTokens)) {
				continue;
			}

			const codexSessionId = tryReadCodexSessionId(
				commandBasename,
				argumentTokens,
			);
			if (codexSessionId) {
				externalAttachedSignals.sessionIds.add(codexSessionId);
				continue;
			}

			if (!isCodexSessionBearingInvocation(commandBasename, argumentTokens)) {
				continue;
			}

			const processCwd = readProcessCwd(pid);
			if (!processCwd) {
				continue;
			}

			const directoryKey = getExternalAttachedDirectoryKey("codex", processCwd);
			incrementDirectoryProcessCount(
				externalAttachedSignals.directoryProcessCounts,
				directoryKey,
			);
			continue;
		}

		const isPiFamilyInvocation =
			isDirectPiFamilyCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedPiFamilyCommand(commandBasename, argumentTokens) ||
			containsPiFamilyToken(argumentTokens);
		if (isPiFamilyInvocation) {
			if (isPiFamilyPrintOrMachineMode(argumentTokens)) {
				continue;
			}

			const piFamilySessionId = tryReadPiFamilySessionId(
				commandBasename,
				argumentTokens,
			);
			if (piFamilySessionId) {
				externalAttachedSignals.sessionIds.add(piFamilySessionId);
				continue;
			}

			if (
				!isPiFamilySessionBearingInvocation(commandBasename, argumentTokens)
			) {
				continue;
			}

			const processCwd = readProcessCwd(pid);
			if (!processCwd) {
				continue;
			}

			const source = getPiFamilyCommandName(commandBasename, argumentTokens);
			const directoryKey = getExternalAttachedDirectoryKey(
				source ?? "pi",
				processCwd,
			);
			incrementDirectoryProcessCount(
				externalAttachedSignals.directoryProcessCounts,
				directoryKey,
			);
			continue;
		}

		const isMctrlInvocation =
			isDirectMctrlCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedMctrlCommand(commandBasename, argumentTokens) ||
			containsMctrlToken(argumentTokens);
		if (isMctrlInvocation) {
			const attachedSessionIdMatch = commandLine.match(
				ATTACHED_SESSION_ID_PATTERN,
			);
			if (attachedSessionIdMatch) {
				externalAttachedSignals.sessionIds.add(attachedSessionIdMatch[2]);
				continue;
			}

			if (isNonSessionMctrlInvocation(commandBasename, argumentTokens)) {
				continue;
			}

			if (!isMctrlSessionBearingInvocation(commandBasename, argumentTokens)) {
				continue;
			}

			const processCwd = readProcessCwd(pid);
			if (!processCwd) {
				continue;
			}

			const directoryKey = getExternalAttachedDirectoryKey(
				"mission-control",
				processCwd,
			);
			incrementDirectoryProcessCount(
				externalAttachedSignals.directoryProcessCounts,
				directoryKey,
			);
			continue;
		}

		const isClaudeInvocation =
			isDirectClaudeCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedClaudeCommand(commandBasename, argumentTokens) ||
			containsClaudeToken(argumentTokens);
		if (!isClaudeInvocation) {
			continue;
		}

		if (hasClaudePrintFlag(argumentTokens)) {
			continue;
		}

		const claudeSessionId = tryReadClaudeSessionId(
			commandBasename,
			argumentTokens,
		);
		if (claudeSessionId) {
			externalAttachedSignals.sessionIds.add(claudeSessionId);
			continue;
		}

		if (!isClaudeSessionBearingInvocation(commandBasename, argumentTokens)) {
			continue;
		}

		const processCwd = readProcessCwd(pid);
		if (!processCwd) {
			continue;
		}

		const directoryKey = getExternalAttachedDirectoryKey("claude", processCwd);
		incrementDirectoryProcessCount(
			externalAttachedSignals.directoryProcessCounts,
			directoryKey,
		);
	}

	return externalAttachedSignals;
};
