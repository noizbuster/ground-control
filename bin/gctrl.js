#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const binDirectory = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(binDirectory, "../dist/index.js");
const bunCommand = process.env.BUN_BINARY?.trim() || "bun";

const result = spawnSync(bunCommand, [entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  if ("code" in result.error && result.error.code === "ENOENT") {
    console.error(
      "gctl requires Bun in your PATH. Install Bun from https://bun.sh and try again.",
    );
    process.exit(1);
  }

  console.error(`Failed to launch gctl with ${bunCommand}: ${result.error.message}`);
  process.exit(1);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
