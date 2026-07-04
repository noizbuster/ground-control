/**
 * Bounded-cache helpers for module-scope `Map` caches that would otherwise grow
 * without limit as new session log files appear on disk.
 *
 * The session monitors (Claude / Codex / Pi / omp / Mission Control) stat and
 * parse every live session file on each 2s refresh and cache the parsed result
 * keyed by absolute path. Without eviction those caches accumulated one entry
 * per session file ever seen — including files long since deleted or archived —
 * which produced an unbounded memory leak over long-running sessions.
 *
 * Usage pattern per cache:
 *   1. On a cache HIT (mtime/size match): call {@link refreshCacheEntryLru} to
 *      re-insert the entry. Map preserves insertion order, so re-insertion
 *      moves a live entry to the newest position. Entries for files that have
 *      disappeared are never hit again, so they drift to the oldest position.
 *   2. Right before a cache MISS `.set(...)`: call
 *      {@link evictOldestCacheEntries} to drop oldest entries until there is
 *      room for one more. Combined with LRU refresh on hits, this evicts stale
 *      (deleted/archived) entries first while keeping the live working set hot.
 */

/**
 * Re-insert an existing cache entry so it becomes the most-recently-used.
 *
 * `Map#set` on an existing key updates the value but leaves the key in its
 * original insertion-order position. Deleting first forces the key to the end,
 * which is what makes frequently-accessed entries survive eviction.
 */
export const refreshCacheEntryLru = <K, V>(
	map: Map<K, V>,
	key: K,
	value: V,
): void => {
	map.delete(key);
	map.set(key, value);
};

/**
 * Drop oldest insertion-order entries until the map has room for one more entry
 * (post-`set` size <= `maxEntries`). Call this immediately before adding a new
 * key. `Map#keys().next().value` yields the first-inserted key still present.
 */
export const evictOldestCacheEntries = <K, V>(
	map: Map<K, V>,
	maxEntries: number,
): void => {
	while (map.size >= maxEntries) {
		const oldestKey = map.keys().next().value;
		if (oldestKey === undefined) {
			break;
		}

		map.delete(oldestKey);
	}
};
