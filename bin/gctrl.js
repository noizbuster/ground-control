#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[H";
const POLL_INTERVAL_MS = 2000;
const DEFAULT_DB_PATH =
  process.env.GCTRL_DB_PATH?.trim() ||
  `${process.env.HOME ?? ""}/.local/share/opencode/opencode.db`;
const OPENCODE_BINARY = process.env.OPENCODE_BINARY?.trim() || "opencode";
const IS_BUN_RUNTIME =
  typeof globalThis.Bun === "object" && globalThis.Bun !== null;

if (IS_BUN_RUNTIME && process.env.GCTRL_LAUNCHED_WITH_NODE !== "1") {
  const nodeBinary = process.env.NODE_BINARY?.trim() || "node";
  const scriptPath = fileURLToPath(import.meta.url);
  const result = spawnSync(
    nodeBinary,
    [scriptPath, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GCTRL_LAUNCHED_WITH_NODE: "1",
      },
    },
  );

  if (result.error) {
    const errorCode = "code" in result.error ? result.error.code : undefined;
    if (errorCode === "ENOENT") {
      console.error(
        `Failed to run Node runtime (${nodeBinary}) from Bun. Install Node.js >= 22.13.0 or set NODE_BINARY.`,
      );
    } else {
      console.error(
        `Failed to relaunch gctrl with Node (${nodeBinary}): ${result.error.message}`,
      );
    }
    console.error(`Current Bun process version context: ${process.versions.node}`);
    process.exit(1);
  }

  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
      process.exit(1);
    } catch {
      process.exit(1);
    }
  }

  process.exit(typeof result.status === "number" ? result.status : 1);
}

const STATUS = {
  pending: "pending",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  unknown: "unknown",
};

const ANSI = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  bold: "\u001B[1m",
  gray: "\u001B[90m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
};

const STATUS_COLORS = {
  [STATUS.pending]: ANSI.gray,
  [STATUS.running]: ANSI.blue,
  [STATUS.waiting]: ANSI.yellow,
  [STATUS.completed]: ANSI.green,
  [STATUS.failed]: ANSI.red,
  [STATUS.unknown]: ANSI.gray,
};

const ACTIVE_SESSION_QUERY = `
SELECT
  session.id,
  session.project_id,
  session.title,
  session.directory,
  project.name AS project_name,
  project.worktree AS project_worktree,
  session.parent_id,
  session.time_created,
  session.time_updated
FROM session
LEFT JOIN project ON project.id = session.project_id
WHERE session.time_archived IS NULL
ORDER BY session.time_updated DESC
`;

const buildLatestMessagesQuery = (sessionCount) => {
  const placeholders = Array.from({ length: sessionCount }, () => "?").join(
    ", ",
  );

  return `
SELECT message.session_id, message.data
FROM message
WHERE message.session_id IN (${placeholders})
  AND message.rowid = (
    SELECT latest.rowid
    FROM message AS latest
    WHERE latest.session_id = message.session_id
    ORDER BY latest.time_created DESC, latest.rowid DESC
    LIMIT 1
  )
`;
};

const parseNodeVersion = (value) => {
  const [majorText = "0", minorText = "0"] = value.split(".");
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);

  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
  };
};

const isSupportedNodeVersion = (version) => {
  if (version.major > 22) {
    return true;
  }

  return version.major === 22 && version.minor >= 13;
};

const version = parseNodeVersion(process.versions.node);
if (!isSupportedNodeVersion(version)) {
  console.error(
    `gctrl requires Node.js >= 22.13.0 for node:sqlite. Current: ${process.versions.node}`,
  );
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (error) {
  console.error(
    "Failed to load node:sqlite. Use Node.js >= 22.13.0 or newer.",
  );
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}

const sanitizeText = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const getLastPathSegment = (value) => {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim().replace(/[\\/]+$/gu, "");
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? null;
};

const getProjectLabel = (session) => {
  const projectName = sanitizeText(session.project_name, "");
  if (projectName) {
    return projectName;
  }

  const worktreeName = getLastPathSegment(session.project_worktree);
  if (worktreeName) {
    return worktreeName;
  }

  return sanitizeText(session.project_id, "unknown-project");
};

const parseMessageData = (raw) => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
};

const hasCompletedMarker = (message) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.finish === "stop") {
    return true;
  }

  const completed = message.time?.completed;
  return typeof completed === "number" && Number.isFinite(completed);
};

const hasFailedMarker = (message) => {
  return !!message && message.finish === "error";
};

const hasQuestionToolSignal = (message) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.tools?.question === true) {
    return true;
  }

  if (message.tools && message.tools.question === false) {
    return false;
  }

  const mode =
    typeof message.mode === "string" ? message.mode.trim().toLowerCase() : "";
  const agent =
    typeof message.agent === "string"
      ? message.agent.trim().toLowerCase()
      : "";

  if (!mode && !agent) {
    return false;
  }

  if (
    mode === "question" ||
    mode === "tool:question" ||
    mode === "question-tool" ||
    mode === "question_tool"
  ) {
    return true;
  }

  return (
    agent === "question" ||
    agent.endsWith("/question") ||
    agent.endsWith(":question")
  );
};

const detectStatus = (message) => {
  if (!message) {
    return STATUS.unknown;
  }

  if (hasFailedMarker(message)) {
    return STATUS.failed;
  }

  if (hasQuestionToolSignal(message) && !hasCompletedMarker(message)) {
    return STATUS.waiting;
  }

  if (hasCompletedMarker(message)) {
    return STATUS.completed;
  }

  return STATUS.running;
};

const padRight = (value, width) => {
  if (value.length >= width) {
    return value;
  }

  return value + " ".repeat(width - value.length);
};

const truncate = (value, maxLength) => {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 1)}…`;
};

const sanitizeSnapshotField = (value) => {
  return String(value ?? "")
    .replace(/[\t\r\n]+/gu, " ")
    .trim();
};

const toLocalTimestamp = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `${month}/${day} ${hour}:${minute}`;
};

const colorize = (value, color) => `${color}${value}${ANSI.reset}`;

const openDatabase = () => {
  return new DatabaseSync(DEFAULT_DB_PATH, { readOnly: true });
};

const loadSnapshot = () => {
  const database = openDatabase();
  try {
    const rows = database.prepare(ACTIVE_SESSION_QUERY).all();
    const sessions = rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      title: sanitizeText(row.title, "Untitled session"),
      directory: sanitizeText(row.directory, process.cwd()),
      project_name: typeof row.project_name === "string" ? row.project_name : null,
      project_worktree:
        typeof row.project_worktree === "string" ? row.project_worktree : null,
      parent_id: typeof row.parent_id === "string" ? row.parent_id : null,
      time_created:
        typeof row.time_created === "number" && Number.isFinite(row.time_created)
          ? row.time_created
          : 0,
      time_updated:
        typeof row.time_updated === "number" && Number.isFinite(row.time_updated)
          ? row.time_updated
          : 0,
      project_label: getProjectLabel(row),
    }));

    const statusBySessionId = new Map();
    if (sessions.length > 0) {
      const latestMessageRows = database
        .prepare(buildLatestMessagesQuery(sessions.length))
        .all(...sessions.map((session) => session.id));

      const latestRawMessageBySessionId = new Map(
        latestMessageRows.map((row) => [String(row.session_id), row.data]),
      );

      for (const session of sessions) {
        const rawMessage = latestRawMessageBySessionId.get(session.id);
        statusBySessionId.set(session.id, detectStatus(parseMessageData(rawMessage)));
      }
    }

    return {
      sessions,
      statusBySessionId,
    };
  } finally {
    database.close();
  }
};

const runCommandWithInheritedIO = ({ command, args, cwd }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve(typeof exitCode === "number" ? exitCode : 1);
    });
  });
};

const runCommandWithCapturedOutput = ({ command, args, cwd }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutText = "";
    let stderrText = "";

    child.stdout?.on("data", (chunk) => {
      stdoutText += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderrText += String(chunk);
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdoutText,
        stderrText,
      });
    });
  });
};

const state = {
  sessions: [],
  statusBySessionId: new Map(),
  selectedIndex: -1,
  scrollTop: 0,
  dbError: null,
  statusMessage: "Loading sessions...",
  pendingDelete: false,
  isBusy: false,
  shuttingDown: false,
  pollTimer: null,
};

const clampSelection = () => {
  if (state.sessions.length === 0) {
    state.selectedIndex = -1;
    state.scrollTop = 0;
    return;
  }

  if (state.selectedIndex < 0) {
    state.selectedIndex = 0;
  } else if (state.selectedIndex >= state.sessions.length) {
    state.selectedIndex = state.sessions.length - 1;
  }
};

const getVisibleRows = () => {
  const rows = process.stdout.rows ?? 24;
  return Math.max(rows - 8, 6);
};

const ensureSelectionVisible = () => {
  if (state.selectedIndex < 0) {
    state.scrollTop = 0;
    return;
  }

  const visibleRows = getVisibleRows();
  if (state.selectedIndex < state.scrollTop) {
    state.scrollTop = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollTop + visibleRows) {
    state.scrollTop = state.selectedIndex - visibleRows + 1;
  }

  const maxScrollTop = Math.max(state.sessions.length - visibleRows, 0);
  state.scrollTop = Math.max(0, Math.min(state.scrollTop, maxScrollTop));
};

const getSelectedSession = () => {
  if (state.selectedIndex < 0 || state.selectedIndex >= state.sessions.length) {
    return null;
  }

  return state.sessions[state.selectedIndex];
};

const copySelectionToClipboard = () => {
  const selected = getSelectedSession();
  if (!selected) {
    state.statusMessage = "No session selected.";
    render();
    return;
  }

  const encoded = Buffer.from(selected.id, "utf8").toString("base64");
  process.stdout.write(`\u001B]52;c;${encoded}\u0007`);
  state.statusMessage = `Copied session ID: ${selected.id}`;
  render();
};

const disableRawInput = () => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
};

const enableRawInput = () => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
};

const moveSelection = (delta) => {
  if (state.sessions.length === 0) {
    return;
  }

  state.pendingDelete = false;
  state.selectedIndex = Math.max(
    0,
    Math.min(state.sessions.length - 1, state.selectedIndex + delta),
  );
  ensureSelectionVisible();
  render();
};

const refreshSessions = () => {
  if (state.isBusy) {
    return;
  }

  const previousSelectedId = getSelectedSession()?.id ?? null;

  try {
    const snapshot = loadSnapshot();
    state.sessions = snapshot.sessions;
    state.statusBySessionId = snapshot.statusBySessionId;
    state.dbError = null;

    if (previousSelectedId) {
      const matchingIndex = state.sessions.findIndex(
        (session) => session.id === previousSelectedId,
      );
      if (matchingIndex >= 0) {
        state.selectedIndex = matchingIndex;
      }
    }

    clampSelection();
    ensureSelectionVisible();

    if (!state.pendingDelete) {
      state.statusMessage = `Last refresh: ${toLocalTimestamp(Date.now())}`;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown database error.";
    state.dbError = message;
    state.statusMessage = "Database read failed.";
  }

  render();
};

const attachToSelectedSession = async () => {
  const selected = getSelectedSession();
  if (!selected || state.isBusy) {
    return;
  }

  state.isBusy = true;
  state.pendingDelete = false;
  state.statusMessage = `Attaching to ${selected.id}...`;
  render();

  disableRawInput();
  process.stdout.write(CLEAR_TERMINAL_SEQUENCE);

  try {
    const exitCode = await runCommandWithInheritedIO({
      command: OPENCODE_BINARY,
      args: ["--session", selected.id],
      cwd: selected.directory,
    });

    if (exitCode === 0) {
      state.statusMessage = `Detached from ${selected.id}.`;
    } else {
      state.statusMessage = `Attach exited with code ${exitCode}.`;
    }
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error
        ? error.code
        : undefined;
    if (errorCode === "ENOENT") {
      state.statusMessage = `Command not found: ${OPENCODE_BINARY}`;
    } else {
      state.statusMessage =
        error instanceof Error ? error.message : "Failed to attach session.";
    }
  } finally {
    state.isBusy = false;
    enableRawInput();
    refreshSessions();
  }
};

const requestDeleteSelectedSession = () => {
  if (!getSelectedSession() || state.isBusy) {
    return;
  }

  state.pendingDelete = true;
  state.statusMessage = "Press y to confirm delete. Press n or Esc to cancel.";
  render();
};

const deleteSelectedSession = async () => {
  const selected = getSelectedSession();
  if (!selected || state.isBusy) {
    return;
  }

  state.isBusy = true;
  state.pendingDelete = false;
  state.statusMessage = `Deleting ${selected.id}...`;
  render();

  try {
    const { exitCode, stdoutText, stderrText } =
      await runCommandWithCapturedOutput({
        command: OPENCODE_BINARY,
        args: ["session", "delete", selected.id],
      });

    if (exitCode === 0) {
      state.statusMessage = `Deleted ${selected.id}.`;
      refreshSessions();
      return;
    }

    const detail = sanitizeText(stderrText || stdoutText, "Delete command failed.");
    state.statusMessage = `Delete failed (${exitCode}): ${detail}`;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error
        ? error.code
        : undefined;
    if (errorCode === "ENOENT") {
      state.statusMessage = `Command not found: ${OPENCODE_BINARY}`;
    } else {
      state.statusMessage =
        error instanceof Error ? error.message : "Failed to delete session.";
    }
  } finally {
    state.isBusy = false;
    render();
  }
};

const render = () => {
  if (!process.stdout.isTTY) {
    return;
  }

  const width = Math.max(process.stdout.columns ?? 80, 60);
  const visibleRows = getVisibleRows();

  clampSelection();
  ensureSelectionVisible();

  const lines = [];
  const title = `${ANSI.bold}gctrl${ANSI.reset} ${ANSI.dim}(Node runtime)${ANSI.reset}`;
  lines.push(`${title}  db=${DEFAULT_DB_PATH}`);

  if (state.dbError) {
    lines.push(colorize(`Database error: ${state.dbError}`, ANSI.red));
  } else {
    lines.push(
      `${ANSI.dim}sessions: ${state.sessions.length} | selected: ${Math.max(
        state.selectedIndex + 1,
        0,
      )}${ANSI.reset}`,
    );
  }

  lines.push("");

  const titleWidth = Math.max(width - 44, 16);
  const visibleSessions = state.sessions.slice(
    state.scrollTop,
    state.scrollTop + visibleRows,
  );

  if (visibleSessions.length === 0) {
    lines.push(`${ANSI.dim}No active sessions found.${ANSI.reset}`);
  } else {
    for (const [offset, session] of visibleSessions.entries()) {
      const index = state.scrollTop + offset;
      const isSelected = index === state.selectedIndex;
      const status = state.statusBySessionId.get(session.id) ?? STATUS.unknown;
      const statusLabel = padRight(status.toUpperCase(), 9);
      const statusColored = colorize(statusLabel, STATUS_COLORS[status] ?? ANSI.gray);

      const marker = isSelected
        ? `${ANSI.bold}${ANSI.cyan}>${ANSI.reset}`
        : " ";
      const projectLabel = truncate(session.project_label, 16);
      const updatedLabel = padRight(toLocalTimestamp(session.time_updated), 11);
      const titleText = truncate(session.title, titleWidth);
      const titleLabel = isSelected
        ? `${ANSI.bold}${titleText}${ANSI.reset}`
        : titleText;

      lines.push(
        `${marker} ${statusColored} ${padRight(titleLabel, titleWidth)} ${ANSI.dim}${padRight(
          projectLabel,
          16,
        )}${ANSI.reset} ${ANSI.dim}${updatedLabel}${ANSI.reset}`,
      );
    }
  }

  lines.push("");

  const selected = getSelectedSession();
  if (selected) {
    lines.push(
      `${ANSI.dim}id:${ANSI.reset} ${selected.id}  ${ANSI.dim}dir:${ANSI.reset} ${truncate(
        selected.directory,
        width - 10,
      )}`,
    );
  } else {
    lines.push(`${ANSI.dim}No session selected.${ANSI.reset}`);
  }

  if (state.pendingDelete) {
    lines.push(
      colorize("Confirm delete: y = yes, n/esc = cancel", ANSI.red),
    );
  } else {
    lines.push(
      `${ANSI.dim}controls:${ANSI.reset} j/k or arrows move  a attach  d delete  i copy id  r refresh  q quit`,
    );
  }

  const statusLine = truncate(state.statusMessage, width);
  lines.push(`${ANSI.dim}${statusLine}${ANSI.reset}`);

  process.stdout.write(CLEAR_TERMINAL_SEQUENCE);
  process.stdout.write(lines.join("\n"));
};

const printNonInteractiveSnapshot = () => {
  try {
    const snapshot = loadSnapshot();
    for (const session of snapshot.sessions) {
      const status = snapshot.statusBySessionId.get(session.id) ?? STATUS.unknown;
      const updated = toLocalTimestamp(session.time_updated);
      process.stdout.write(
        `${status.toUpperCase()}\t${updated}\t${sanitizeSnapshotField(
          session.project_label,
        )}\t${sanitizeSnapshotField(session.id)}\t${sanitizeSnapshotField(
          session.title,
        )}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to read OpenCode database: ${message}`);
    process.exit(1);
  }
};

const shutdown = (exitCode) => {
  if (state.shuttingDown) {
    process.exit(exitCode);
  }

  state.shuttingDown = true;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  disableRawInput();
  process.stdin.pause();
  process.stdout.write(`${CLEAR_TERMINAL_SEQUENCE}${ANSI.reset}`);
  process.exit(exitCode);
};

const onKeypress = (character, key) => {
  if (key?.ctrl && key.name === "c") {
    shutdown(0);
    return;
  }

  if (state.isBusy) {
    return;
  }

  if (state.pendingDelete) {
    if (key.name === "y" || character === "y") {
      void deleteSelectedSession();
      return;
    }

    if (
      key.name === "n" ||
      character === "n" ||
      key.name === "escape" ||
      key.name === "d"
    ) {
      state.pendingDelete = false;
      state.statusMessage = "Delete cancelled.";
      render();
      return;
    }
  }

  switch (key.name) {
    case "up":
      moveSelection(-1);
      return;
    case "down":
      moveSelection(1);
      return;
    case "return":
    case "enter":
      void attachToSelectedSession();
      return;
    case "escape":
      if (state.pendingDelete) {
        state.pendingDelete = false;
        state.statusMessage = "Delete cancelled.";
        render();
      }
      return;
    default:
      break;
  }

  const lowerCharacter = typeof character === "string" ? character.toLowerCase() : "";
  switch (lowerCharacter) {
    case "j":
      moveSelection(1);
      break;
    case "k":
      moveSelection(-1);
      break;
    case "a":
      void attachToSelectedSession();
      break;
    case "d":
      requestDeleteSelectedSession();
      break;
    case "i":
      copySelectionToClipboard();
      break;
    case "r":
      refreshSessions();
      break;
    case "q":
      shutdown(0);
      break;
    default:
      break;
  }
};

const startInteractiveMonitor = () => {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKeypress);

  enableRawInput();
  process.stdin.resume();

  process.stdout.on("resize", render);
  process.on("SIGTERM", () => shutdown(0));

  refreshSessions();
  state.pollTimer = setInterval(refreshSessions, POLL_INTERVAL_MS);
};

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  printNonInteractiveSnapshot();
  process.exit(0);
}

startInteractiveMonitor();
