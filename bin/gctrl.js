#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const bunPackageDir = dirname(require.resolve("bun/package.json"));
const bunPath = resolve(bunPackageDir, "bin", "bun.exe");
const entryPath = resolve(__dirname, "..", "dist", "index.js");

const child = spawn(bunPath, [entryPath], {
	stdio: "inherit",
	env: process.env,
});

child.on("exit", (code) => {
	process.exit(code ?? 0);
});
