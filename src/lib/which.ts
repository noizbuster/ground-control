import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve a binary name to its absolute path by searching process.env.PATH.
 * Replaces Bun.which(name). Returns the resolved path or null when not found.
 */
export const which = (name: string): string | null => {
	if (name.length === 0) return null;

	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, name);
		if (!existsSync(candidate)) continue;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(candidate);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if ((stat.mode & 0o111) === 0) continue;
		return candidate;
	}
	return null;
};
