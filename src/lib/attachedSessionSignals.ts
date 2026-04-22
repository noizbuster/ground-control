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
const OPENCODE_WRAPPED_BASENAMES = new Set(["opencode", ".opencode"]);
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

const isCodexToken = (token: string): boolean => {
	const normalizedToken = normalizeCommandToken(token);
	if (normalizedToken.length === 0) {
		return false;
	}

	return getBasename(normalizedToken) === CODEX_COMMAND_NAME;
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

export const getExternalAttachedDirectoryKey = (
	source: SessionSource,
	directory: string,
): string => {
	return `${source}:${directory}`;
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
			const existingCount =
				externalAttachedSignals.directoryProcessCounts.get(directoryKey) ?? 0;
			externalAttachedSignals.directoryProcessCounts.set(
				directoryKey,
				existingCount + 1,
			);
			continue;
		}

		const isCodexInvocation =
			isDirectCodexCommand(commandBasename, firstArgumentBasename) ||
			isRuntimeWrappedCodexCommand(commandBasename, argumentTokens) ||
			containsCodexToken(argumentTokens);
		if (!isCodexInvocation) {
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
		if (!externalAttachedSignals.directoryProcessCounts.has(directoryKey)) {
			externalAttachedSignals.directoryProcessCounts.set(directoryKey, 1);
		}
	}

	return externalAttachedSignals;
};
