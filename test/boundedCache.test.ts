import { describe, expect, it } from "vitest";
import {
	evictOldestCacheEntries,
	refreshCacheEntryLru,
} from "../src/lib/boundedCache";

describe("evictOldestCacheEntries", () => {
	it("is a no-op below the cap", () => {
		const map = new Map([
			["a", 1],
			["b", 2],
		]);
		evictOldestCacheEntries(map, 5);
		expect([...map]).toEqual([
			["a", 1],
			["b", 2],
		]);
	});

	it("drops only the oldest insertion-order entry at the cap boundary", () => {
		const map = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
		// Called before adding a 4th entry with cap 3: should free one slot.
		evictOldestCacheEntries(map, 3);
		expect([...map]).toEqual([
			["b", 2],
			["c", 3],
		]);
	});

	it("evicts repeatedly until room exists for one more entry", () => {
		const map = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
			["d", 4],
			["e", 5],
		]);
		evictOldestCacheEntries(map, 3);
		expect([...map]).toEqual([
			["d", 4],
			["e", 5],
		]);
	});

	it("never grows the map and never throws on an empty map", () => {
		const map = new Map();
		evictOldestCacheEntries(map, 3);
		expect(map.size).toBe(0);
	});
});

describe("refreshCacheEntryLru", () => {
	it("moves an existing key to the newest insertion-order position", () => {
		const map = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
		// Touch "a": it was oldest, should become newest.
		refreshCacheEntryLru(map, "a", 1);
		expect([...map.keys()]).toEqual(["b", "c", "a"]);
		expect(map.get("a")).toBe(1);
	});

	it("preserves value when re-inserting", () => {
		const value = { n: 1 };
		const map = new Map([["a", value]]);
		refreshCacheEntryLru(map, "a", value);
		expect(map.get("a")).toBe(value);
	});

	it("combined with eviction keeps recently-touched entries and drops stale ones", () => {
		// Simulate a refresh cycle: a, b, c are live (touched), d is stale.
		const map = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
			["d", 4],
		]);
		// Live entries get re-inserted each refresh; stale "d" does not.
		refreshCacheEntryLru(map, "a", 1);
		refreshCacheEntryLru(map, "b", 2);
		refreshCacheEntryLru(map, "c", 3);
		// Order is now d (oldest/stale), a, b, c (newest/live).
		expect([...map.keys()]).toEqual(["d", "a", "b", "c"]);

		// New entry "e" arrives: evict makes room, dropping stale "d" first.
		evictOldestCacheEntries(map, 4);
		map.set("e", 5);
		expect([...map]).toEqual([
			["a", 1],
			["b", 2],
			["c", 3],
			["e", 5],
		]);
		expect(map.has("d")).toBe(false);
	});
});
