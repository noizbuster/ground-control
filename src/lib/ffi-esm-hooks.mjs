// ESM resolve hook: redirect `import("node:ffi")` to the koffi CJS adapter.
//
// This catches opentui's async `importModule("node:ffi")` at top-level await
// (bun-ffi-structs, inlined in the opentui bundle). The sync
// `requireModule("node:ffi")` site is handled by the Module._load patch in
// ffi-register.mjs — both layers are required because opentui reaches node:ffi
// through CJS require AND ESM import.
//
// Installed via `register("./ffi-esm-hooks.mjs", import.meta.url)` from
// ffi-register.mjs (the --import entry).
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "node:ffi") {
		return {
			url: new URL("./ffi-koffi-adapter.cjs", import.meta.url).href,
			shortCircuit: true,
		};
	}
	return nextResolve(specifier, context);
}
