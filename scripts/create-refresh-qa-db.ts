import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_OUTPUT_PATH = ".sisyphus/evidence/qa-refresh.sqlite";
const BASE_TIME = 1_762_000_000_000;

interface ScriptOptions {
	outputPath: string;
}

const parseArgs = (argv: string[]): ScriptOptions => {
	let outputPath = DEFAULT_OUTPUT_PATH;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];

		if (token === "--output" || token === "-o") {
			const nextToken = argv[index + 1];
			if (!nextToken) {
				throw new Error(`Missing value for ${token}.`);
			}

			outputPath = nextToken;
			index += 1;
			continue;
		}

		if (!token.startsWith("-")) {
			outputPath = token;
			continue;
		}

		throw new Error(`Unknown argument: ${token}`);
	}

	return { outputPath };
};

const encode = (value: Record<string, unknown>): string => JSON.stringify(value);

const createSchema = (db: Database): void => {
	db.exec(`
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT,
  worktree TEXT
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  directory TEXT NOT NULL,
  parent_id TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_archived INTEGER
);

CREATE TABLE message (
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  data TEXT
);

CREATE TABLE part (
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  data TEXT
);

CREATE INDEX idx_message_session_time
ON message (session_id, time_created DESC);

CREATE INDEX idx_part_session_time
ON part (session_id, time_created DESC);
`);
};

const seedFixtureData = (db: Database): void => {
	const insertProject = db.query(
		"INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)",
	);
	const insertSession = db.query(
		"INSERT INTO session (id, project_id, title, directory, parent_id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertMessage = db.query(
		"INSERT INTO message (session_id, time_created, data) VALUES (?, ?, ?)",
	);
	const insertPart = db.query(
		"INSERT INTO part (session_id, time_created, data) VALUES (?, ?, ?)",
	);

	insertProject.run("project-alpha", "Alpha Launch", "/workspaces/alpha");
	insertProject.run("project-beta", null, "/workspaces/beta");
	insertProject.run("project-gamma", "Gamma Hold", "/workspaces/gamma");

	insertSession.run(
		"session-alpha",
		"project-alpha",
		"alpha",
		"/workspaces/alpha",
		null,
		BASE_TIME + 100,
		BASE_TIME + 900,
		null,
	);
	insertSession.run(
		"session-beta",
		"project-beta",
		"beta",
		"/workspaces/beta",
		null,
		BASE_TIME + 200,
		BASE_TIME + 1_000,
		null,
	);
	insertSession.run(
		"session-gamma",
		"project-gamma",
		"gamma",
		"/workspaces/gamma",
		null,
		BASE_TIME + 300,
		BASE_TIME + 1_100,
		null,
	);

	insertMessage.run(
		"session-alpha",
		BASE_TIME + 350,
		encode({
			role: "user",
			time: { created: BASE_TIME + 350 },
		}),
	);
	insertMessage.run(
		"session-alpha",
		BASE_TIME + 500,
		encode({
			role: "assistant",
			agent: "orchestrator",
			finish: "stop",
			time: { created: BASE_TIME + 500, completed: BASE_TIME + 510 },
			tokens: { input: 121, output: 450 },
		}),
	);

	insertMessage.run(
		"session-beta",
		BASE_TIME + 600,
		encode({
			role: "user",
			time: { created: BASE_TIME + 600 },
		}),
	);
	insertMessage.run(
		"session-beta",
		BASE_TIME + 760,
		encode({
			role: "assistant",
			agent: "build",
			time: { created: BASE_TIME + 760 },
			tokens: { input: 220, output: 198 },
		}),
	);

	insertMessage.run(
		"session-gamma",
		BASE_TIME + 700,
		encode({
			role: "user",
			time: { created: BASE_TIME + 700 },
		}),
	);
	insertMessage.run(
		"session-gamma",
		BASE_TIME + 790,
		encode({
			role: "assistant",
			agent: "planner",
			time: { created: BASE_TIME + 790 },
			tools: { question: false },
		}),
	);

	insertPart.run(
		"session-gamma",
		BASE_TIME + 800,
		encode({
			type: "tool",
			tool: "question",
			state: { status: "running" },
			input: { prompt: "Can I continue with deployment?" },
		}),
	);

	// --- Hierarchy fixture data ---

	// Root session with 4 subagents (running, completed, failed, waiting)
	insertSession.run(
		"session-hierarchy",
		"project-alpha",
		"hierarchy",
		"/workspaces/alpha",
		null,
		BASE_TIME + 1_200,
		BASE_TIME + 2_000,
		null,
	);
	insertMessage.run(
		"session-hierarchy",
		BASE_TIME + 1_250,
		encode({
			role: "user",
			time: { created: BASE_TIME + 1_250 },
		}),
	);
	insertMessage.run(
		"session-hierarchy",
		BASE_TIME + 1_800,
		encode({
			role: "assistant",
			agent: "orchestrator",
			finish: "stop",
			time: { created: BASE_TIME + 1_800, completed: BASE_TIME + 1_850 },
			tokens: { input: 300, output: 800 },
		}),
	);

	// Subagent: completed (finish: "stop" with time.completed)
	insertSession.run(
		"session-sub-completed",
		"project-alpha",
		"explore-deps",
		"/workspaces/alpha",
		"session-hierarchy",
		BASE_TIME + 1_300,
		BASE_TIME + 1_450,
		null,
	);
	insertMessage.run(
		"session-sub-completed",
		BASE_TIME + 1_310,
		encode({
			role: "user",
			time: { created: BASE_TIME + 1_310 },
		}),
	);
	insertMessage.run(
		"session-sub-completed",
		BASE_TIME + 1_400,
		encode({
			role: "assistant",
			agent: "explore",
			finish: "stop",
			time: { created: BASE_TIME + 1_400, completed: BASE_TIME + 1_450 },
			tokens: { input: 150, output: 320 },
		}),
	);

	// Subagent: running (no finish, no completed time)
	insertSession.run(
		"session-sub-running",
		"project-alpha",
		"build-feature",
		"/workspaces/alpha",
		"session-hierarchy",
		BASE_TIME + 1_500,
		BASE_TIME + 1_950,
		null,
	);
	insertMessage.run(
		"session-sub-running",
		BASE_TIME + 1_510,
		encode({
			role: "user",
			time: { created: BASE_TIME + 1_510 },
		}),
	);
	insertMessage.run(
		"session-sub-running",
		BASE_TIME + 1_900,
		encode({
			role: "assistant",
			agent: "build",
			time: { created: BASE_TIME + 1_900 },
			tokens: { input: 400, output: 600 },
		}),
	);

	// Subagent: failed (finish: "error")
	insertSession.run(
		"session-sub-failed",
		"project-alpha",
		"fix-auth-bug",
		"/workspaces/alpha",
		"session-hierarchy",
		BASE_TIME + 1_600,
		BASE_TIME + 1_700,
		null,
	);
	insertMessage.run(
		"session-sub-failed",
		BASE_TIME + 1_610,
		encode({
			role: "user",
			time: { created: BASE_TIME + 1_610 },
		}),
	);
	insertMessage.run(
		"session-sub-failed",
		BASE_TIME + 1_650,
		encode({
			role: "assistant",
			agent: "build",
			finish: "error",
			time: { created: BASE_TIME + 1_650, completed: BASE_TIME + 1_700 },
			tokens: { input: 250, output: 80 },
		}),
	);

	// Subagent: waiting (tools.question: true, no finish)
	insertSession.run(
		"session-sub-waiting",
		"project-alpha",
		"review-impl",
		"/workspaces/alpha",
		"session-hierarchy",
		BASE_TIME + 1_750,
		BASE_TIME + 1_850,
		null,
	);
	insertMessage.run(
		"session-sub-waiting",
		BASE_TIME + 1_760,
		encode({
			role: "user",
			time: { created: BASE_TIME + 1_760 },
		}),
	);
	insertMessage.run(
		"session-sub-waiting",
		BASE_TIME + 1_800,
		encode({
			role: "assistant",
			agent: "momus",
			time: { created: BASE_TIME + 1_800 },
			tools: { question: true },
		}),
	);

	// Root session with no subagents (empty-state case) + long title for truncation
	insertSession.run(
		"session-empty-root",
		"project-beta",
		"This Is A Very Long Session Title Designed To Test Truncation Behavior When The Title Exceeds The Available Column Width In The Hierarchy View Panel Display",
		"/workspaces/beta",
		null,
		BASE_TIME + 2_100,
		BASE_TIME + 2_100,
		null,
	);
	insertMessage.run(
		"session-empty-root",
		BASE_TIME + 2_110,
		encode({
			role: "user",
			time: { created: BASE_TIME + 2_110 },
		}),
	);
};

const main = async () => {
	const options = parseArgs(Bun.argv.slice(2));
	const outputPath = resolve(process.cwd(), options.outputPath);

	await mkdir(dirname(outputPath), { recursive: true });
	await rm(outputPath, { force: true });

	const db = new Database(outputPath);

	try {
		createSchema(db);
		db.exec("BEGIN IMMEDIATE TRANSACTION;");
		seedFixtureData(db);
		db.exec("COMMIT;");
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {}
		throw error;
	} finally {
		db.close();
	}

	console.log(`Created deterministic QA fixture at ${outputPath}`);
	console.log(
		"Seeded root sessions: alpha, beta, gamma, hierarchy, empty-root",
	);
	console.log("Seeded subagents under session-hierarchy: completed, running, failed, waiting");
	console.log("Seeded long-title root session: session-empty-root (no subagents)");
};

void main();
