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
