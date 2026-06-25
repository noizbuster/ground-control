// esbuild-based build. Replaces tsc-emit because tsc with moduleResolution:
// "Bundler" emits extensionless relative imports (e.g. `from "./db/claude"`)
// that Node ESM rejects (ERR_MODULE_NOT_FOUND). Bun was lenient; Node is not.
//
// Strategy: bundle each entry point so ALL local relative imports are inlined
// into a single output file. node_modules packages stay external (imported at
// runtime via the real package), so @opentui/core, koffi, and node:* builtins
// are never bundled. This eliminates every relative-import resolution issue.
//
// Entry points:
//   src/index.ts            -> dist/index.js            (main app)
//   src/db/refresh-worker.ts -> dist/db/refresh-worker.js (worker thread)
//
// The worker is spawned at runtime via:
//   new Worker(new URL(`./db/refresh-worker${ext}`, import.meta.url))
// Since `ext` is a runtime variable, esbuild cannot statically resolve the
// new URL(...) and leaves it as a runtime call — safe.
//
// Usage:
//   node scripts/build.mjs          # one-shot build
//   node scripts/build.mjs --watch  # watch mode (for `pnpm dev`)
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distDir = resolve(projectRoot, "dist");

const watch = process.argv.includes("--watch");

const commonOptions = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2022",
	// Externalize EVERY node_modules package: only local src/ files are
	// bundled/inlined. node:* builtins are always external under platform:node.
	packages: "external",
	sourcemap: false,
	logLevel: "info",
};

const entryPoints = [
	{
		entryPoint: "src/index.ts",
		outfile: "dist/index.js",
	},
	{
		entryPoint: "src/db/refresh-worker.ts",
		outfile: "dist/db/refresh-worker.js",
	},
];

function buildOptions(ep) {
	return {
		...commonOptions,
		entryPoints: [resolve(projectRoot, ep.entryPoint)],
		outfile: resolve(projectRoot, ep.outfile),
	};
}

if (!watch) {
	// Clean stale tsc-emitted files so the published dist/ only contains what
	// esbuild + copy-hooks produce.
	rmSync(distDir, { recursive: true, force: true });

	for (const ep of entryPoints) {
		await esbuild.build(buildOptions(ep));
	}
} else {
	// Watch mode: clean once, then build all entry points with shared context.
	rmSync(distDir, { recursive: true, force: true });

	const contexts = [];
	for (const ep of entryPoints) {
		const ctx = await esbuild.context(buildOptions(ep));
		await ctx.watch();
		contexts.push(ctx);
	}
	console.log("[build] watching for changes...");
}
