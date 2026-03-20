import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const [rootArg] = process.argv.slice(2);
const DIST_DIR = path.resolve(process.cwd(), rootArg ?? "dist");

const SHOULD_KEEP_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".node"];
const EXTENSION_REWRITE_TO_JS = [".ts", ".tsx", ".cts", ".mts"];

const hasKnownExtension = (specifier) => {
	const ext = path.extname(specifier);
	return ext !== "" && SHOULD_KEEP_EXTENSIONS.includes(ext);
};

const rewritePathExtensionToJs = (filePath, specifier) => {
	const ext = path.extname(specifier);
	const fromDir = path.dirname(filePath);

	if (EXTENSION_REWRITE_TO_JS.includes(ext)) {
		return `${specifier.slice(0, -ext.length)}.js`;
	}

	const resolvedPath = path.resolve(fromDir, specifier);
	const resolvedPathStat = statSync(resolvedPath, { throwIfNoEntry: false });
	if (resolvedPathStat?.isDirectory()) {
		const indexJsPath = path.join(resolvedPath, "index.js");
		if (statSync(indexJsPath, { throwIfNoEntry: false })) {
			return `${specifier.replace(/\/$/, "")}/index.js`;
		}
	}

	if (!hasKnownExtension(specifier)) {
		return `${specifier}.js`;
	}

	return specifier;
};

const shouldFixSpecifier = (specifier) => {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return false;
	}

	if (specifier.endsWith("/")) {
		return false;
	}

	return !hasKnownExtension(specifier);
};

const rewriteSpecifier = (filePath, specifier) =>
	shouldFixSpecifier(specifier) ? rewritePathExtensionToJs(filePath, specifier) : specifier;

const FIX_IMPORT_FROM_RE = /\b(?:import|export)\b[^"'`]*?\bfrom\s+(["'])([^"']+)\1/g;
const FIX_IMPORT_RE = /\bimport\s+(["'])([^"']+)\1/g;
const FIX_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const FIX_WORKER_URL_RE = /\bnew URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;

const fixImportSpecifiers = (filePath, content) => {
	const replaceRelativeImport = (fullMatch, _quote, specifier) => {
		const next = rewriteSpecifier(filePath, specifier);
		return fullMatch.replace(specifier, next);
	};

	return (
		content
			.replace(FIX_IMPORT_FROM_RE, (_m, quote, specifier) =>
				replaceRelativeImport(_m, quote, specifier),
			)
			.replace(FIX_IMPORT_RE, (_m, quote, specifier) =>
				replaceRelativeImport(_m, quote, specifier),
			)
			.replace(FIX_DYNAMIC_IMPORT_RE, (_m, quote, specifier) =>
				replaceRelativeImport(_m, quote, specifier),
			)
			.replace(FIX_WORKER_URL_RE, (_m, quote, specifier) => {
				const next = rewriteSpecifier(filePath, specifier);
				if (next === specifier) {
					return _m;
				}

				return `new URL(${quote}${next}${quote}, import.meta.url)`;
			})
	);
};

const processFile = (filePath) => {
	const stat = statSync(filePath);
	if (stat.isDirectory()) {
		return;
	}

	if (!filePath.endsWith(".js")) {
		return;
	}

	const content = readFileSync(filePath, "utf8");
	const nextContent = fixImportSpecifiers(filePath, content);

	if (nextContent !== content) {
		writeFileSync(filePath, nextContent);
	}
};

const walk = (dirPath) => {
	for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
		const child = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			walk(child);
			continue;
		}

		if (entry.isFile()) {
			processFile(child);
		}
	}
};

walk(DIST_DIR);
