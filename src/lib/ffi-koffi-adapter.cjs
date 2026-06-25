// koffi-backed implementation of opentui's NodeFfiBackend contract.
//
// Replaces node:ffi on Node 24, where the node:ffi builtin is absent until
// v26.1. opentui's bundle reaches node:ffi through two sites:
//   - sync  requireModule("node:ffi")  -> createNodeBackend   (CJS, Module._load)
//   - async importModule("node:ffi")    -> createNodeBackend2  (ESM, bun-ffi-structs)
// Both are redirected here by ffi-register.mjs / ffi-esm-hooks.mjs.
//
// Version-agnostic across koffi 2.x and 3.x: the only divergence is the
// callback registration return shape (3.x returns the bigint pointer
// directly; 2.x returns an opaque object whose address comes from
// koffi.address()). We branch on koffi.version so the same file works under
// either pin.
//
// NOTE on Node 24 + callbacks: persistent callbacks (log/event handlers) need
// koffi >= 2.15.3, which carries the "IsOnCentralStack" / Node-24 callback
// crash fixes. koffi 3.0.x did not receive those fixes and segfaults inside
// koffi.register() on Node 24. The import path (the T8 acceptance bar) does
// not exercise registerCallback, so import succeeds under either version;
// actual rendering requires the 2.x pin.
"use strict";

const koffi = require("koffi");

// opentui's toNodeFFIType emits exactly these strings; normalizeNodeDefinition
// converts its own FFIType enum to them before calling dlopen. Each maps to a
// koffi type specifier accepted by lib.func() and koffi.proto().
const TYPE_MAP = {
	void: "void",
	char: "char",
	i8: "int8_t",
	u8: "uint8_t",
	i16: "int16_t",
	u16: "uint16_t",
	i32: "int32_t",
	u32: "uint32_t",
	i64: "int64_t",
	u64: "uint64_t",
	f32: "float",
	f64: "double",
	// opentui's ffiBool(v) returns a Number (v ? 1 : 0); koffi 3.x "bool"
	// rejects Numbers ("Unexpected Number value, expected boolean"). uint8_t
	// accepts Numbers and has the identical C ABI to _Bool (1 byte), so it is
	// a drop-in for both parameters and results across all ffiBool call sites.
	bool: "uint8_t",
	pointer: "void *",
	// toNodeFFIType only emits "string" for parameters (cstring result throws
	// NODE_STRING_RETURN), so it never appears as a return type. koffi accepts
	// a JS string for "char *" by copying it to a transient NUL-terminated
	// buffer for the duration of the call.
	string: "char *",
	// opentui's FFIType.buffer is pointer-like under node:ffi.
	buffer: "void *",
};

function mapType(nodeType) {
	const mapped = TYPE_MAP[nodeType];
	if (mapped === undefined) {
		throw new TypeError(
			`ffi-koffi-adapter: unmapped node:ffi type "${nodeType}"`,
		);
	}
	return mapped;
}

function mapArgTypes(args) {
	return (args == null ? [] : args).map(mapType);
}

const koffiMajor =
	Number.parseInt(String(koffi.version).split(".")[0], 10) || 3;
// 3.x: register() returns the bigint pointer, unregister() takes a bigint.
// 2.x: register() returns an opaque object; address() yields the pointer and
// unregister() takes the object.
const REGISTER_RETURNS_BIGINT = koffiMajor >= 3;

// 2.x only: bigint pointer -> registered-callback object, so unregister can
// recover the object from the pointer opentui hands back.
const callbackRegistry = new Map();
let callbackSeq = 0;

function registerCallback(signature, callback) {
	const retType = mapType(signature.return);
	const argTypes = mapArgTypes(signature.arguments);
	// koffi requires NAMED callback prototypes for register(); an anonymous
	// proto is rejected. A per-registration unique name avoids collisions when
	// many callbacks share the same shape.
	const protoName = `__otui_cb_${callbackSeq++}`;
	const proto = koffi.proto(protoName, retType, argTypes);
	const registered = koffi.register(callback, koffi.pointer(proto));

	if (REGISTER_RETURNS_BIGINT) {
		return registered;
	}
	const pointer = koffi.address(registered);
	callbackRegistry.set(pointer, registered);
	return pointer;
}

function unregisterCallback(pointer) {
	if (REGISTER_RETURNS_BIGINT) {
		koffi.unregister(pointer);
		return;
	}
	const registered = callbackRegistry.get(pointer);
	if (registered !== undefined) {
		callbackRegistry.delete(pointer);
		koffi.unregister(registered);
	}
}

// opentui's NodeDynamicLibrary contract: { close, registerCallback,
// unregisterCallback }. close() is invoked from the library teardown path; we
// intentionally do NOT koffi.unload() the shared library here because native
// callbacks (and other held symbols) may still be live for the process
// lifetime, and the OS reclaims the mapping at exit. Unloading eagerly risks
// use-after-unload crashes.
function makeLib() {
	return {
		close() {},
		registerCallback,
		unregisterCallback,
	};
}

const backend = {
	suffix:
		process.platform === "darwin"
			? ".dylib"
			: process.platform === "win32"
				? ".dll"
				: ".so",

	dlopen(path, symbols) {
		// opentui resolves a real libopentui.* path before calling here; the
		// null path is a Bun-only path (BUN_DLOPEN_NULL) never taken by the
		// node backend.
		const lib = koffi.load(path);
		const functions = {};
		for (const name of Object.keys(symbols)) {
			const sig = symbols[name];
			// Use the (name, result, arguments) overload rather than the
			// single-string "result name(args)" form: the latter's type parser
			// rejects some pointer/callback shapes and is needlessly fragile.
			functions[name] = lib.func(
				name,
				mapType(sig.return),
				mapArgTypes(sig.arguments),
			);
		}
		return { lib: makeLib(), functions };
	},

	getRawPointer(source) {
		// opentui hands us an ArrayBuffer (TypedArray.buffer, or the
		// ArrayBuffer itself). Buffer.from(arraybuffer) is a zero-copy view,
		// so koffi.address returns the ArrayBuffer's true backing pointer.
		const view = Buffer.isBuffer(source) ? source : Buffer.from(source);
		return koffi.address(view);
	},

	toArrayBuffer(pointer, length, copy) {
		// koffi.view returns a LIVE ArrayBuffer over native memory: JS writes
		// through a DataView propagate to native and vice versa. bun-ffi-structs
		// reads AND writes struct fields through this buffer, so a live view is
		// mandatory; a snapshot copy would silently drop every JS-side write.
		// opentui always passes copy=false.
		const buffer = koffi.view(pointer, length);
		return copy ? buffer.slice(0) : buffer;
	},
};

module.exports = backend;
module.exports.default = backend;
