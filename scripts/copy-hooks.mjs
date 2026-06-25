// Copies the hand-written FFI hook files (ffi-koffi-adapter.cjs,
// ffi-esm-hooks.mjs, ffi-register.mjs) from src/lib/ to dist/lib/.
//
// These files are .cjs/.mjs (not .ts), so tsc does not emit them. They must be
// copied explicitly so the published package's dist/lib/ contains the register
// hook that bin/gctrl.js loads via `node --import dist/lib/ffi-register.mjs`.
//
// Run after `tsc --project tsconfig.build.json` (see package.json `build`).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const srcDir = resolve(projectRoot, "src", "lib");
const destDir = resolve(projectRoot, "dist", "lib");

const HOOK_FILES = [
	"ffi-koffi-adapter.cjs",
	"ffi-esm-hooks.mjs",
	"ffi-register.mjs",
];

mkdirSync(destDir, { recursive: true });

for (const file of HOOK_FILES) {
	copyFileSync(resolve(srcDir, file), resolve(destDir, file));
}
