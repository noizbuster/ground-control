#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = path.join(ROOT_DIR, "dist", "index.js");

const CLI_ARGS = process.argv.slice(2);

const hasFile = (filePath) => {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

const run = (command, args) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
		},
	});

  if (result.error) {
    throw result.error;
  }

	return typeof result.status === "number" ? result.status : 1;
};

if (hasFile(DIST_ENTRY)) {
	process.exit(run(process.execPath, [DIST_ENTRY, ...CLI_ARGS]));
}

throw new Error(
  `Missing built app: ${DIST_ENTRY}. Run 'npm run build' first and try again.`,
);
