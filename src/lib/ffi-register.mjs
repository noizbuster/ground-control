// --import entry that installs BOTH node:ffi interception layers, so opentui
// loads the koffi adapter no matter which of its two node:ffi sites runs:
//
//   node --import ./dist/lib/ffi-register.mjs bin/gctrl.js
//
// Layer 1 (ESM resolve hook): catches `import("node:ffi")` — opentui's
//   async importModule("node:ffi") from the inlined bun-ffi-structs module,
//   which runs at top-level await during `import("@opentui/core")`.
//
// Layer 2 (Module._load patch): catches `require("node:ffi")` — opentui's
//   sync requireModule("node:ffi") from createNodeBackend. Module._load must
//   return the adapter synchronously, so the adapter is CJS and loaded here
//   via createRequire (a bare `require` is undefined in ESM).
//
// The dual-hook mechanism is empirically verified; see
// .omo/notepads/opentui-upgrade-bun-removal/learnings.md.
import Module, { createRequire, register } from "node:module";

const require = createRequire(import.meta.url);

// Layer 1: ESM import("node:ffi") -> ffi-koffi-adapter.cjs
register("./ffi-esm-hooks.mjs", import.meta.url);

// Layer 2: CJS require("node:ffi") -> ffi-koffi-adapter.cjs
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
	if (request === "node:ffi") {
		return require("./ffi-koffi-adapter.cjs");
	}
	return originalLoad.apply(this, [request, ...rest]);
};

// Layer 3: suppress koffi 3.x callback errors from opentui's TUI console.
// koffi 3.x on Node 24+ can't recycle callbacks (unregister is broken).
// After 8192, koffi.register throws. opentui catches this via
// process.on("uncaughtException") and displays it in the console panel.
// These errors are koffi bugs, not app bugs — filter them out.
const KOFFI_ERRORS = [
	"Too many callbacks",
	"Failed to create SyntaxStyle",
	"Failed to create optimized buffer",
	"Failed to create frame buffer",
	"Failed to create Yoga",
];
const isKoffiErr = (...args) =>
	args.some((a) => {
		const s = a?.message ?? String(a ?? "");
		return KOFFI_ERRORS.some((p) => s.includes(p));
	});

const _on = process.on.bind(process);
process.on = (ev, fn, ...r) => {
	if (ev === "uncaughtException" || ev === "unhandledRejection") {
		return _on(ev, (e) => { if (!isKoffiErr(e)) fn(e); }, ...r);
	}
	return _on(ev, fn, ...r);
};
