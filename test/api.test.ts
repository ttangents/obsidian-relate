import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { EventRef, Events } from "obsidian";
import { ApiProvider, EVENT_CHANGED, EVENT_READY, EVENT_REQUEST, EVENT_UNLOAD, createApi, type ApiDeps, type RelateApi } from "../src/api";
import { sidesOf } from "../src/settings";

/** An API over an empty vault that records what it was asked. */
function fakeDeps(over: Partial<ApiDeps> = {}): ApiDeps & { limits: number[] } {
	const limits: number[] = [];
	const relations = [{ property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true }];
	const deps: ApiDeps & { limits: number[] } = {
		limits,
		live: () => true,
		index: { targets: () => new Set(), incoming: () => new Set() },
		sides: () => sidesOf(relations),
		relations: () => relations,
		queries: { related: () => new Set(["B.md"]), connections: () => [{ from: "A.md", prop: "parent", to: "B.md" }] },
		search: async () => [],
		semantic: {
			ready: true,
			similar: (_path, limit) => {
				limits.push(limit);
				return [{ path: "B.md", score: 0.9 }];
			},
		},
		note: () => null,
		connect: async () => ({ applied: [], skipped: [], error: null }),
		disconnect: async () => ({ applied: [], skipped: [], error: null }),
		changed: () => {},
		...over,
	};
	return deps;
}

test("[review 21] similar keeps its limit between 1 and 50, like paths", () => {
	const deps = fakeDeps();
	const api = createApi(deps);
	api.similar("A.md", 1000);
	api.similar("A.md", -3);
	api.similar("A.md");
	assert.deepEqual(deps.limits, [50, 1, 5]);
});

test("[integration 8] once Relate unloads, the API is inert: reads come back empty and changes do nothing", async () => {
	let live = true;
	let connects = 0;
	const deps = fakeDeps({
		live: () => live,
		connect: async () => {
			connects++;
			return { applied: [], skipped: [], error: null };
		},
	});
	const api = createApi(deps);
	assert.deepEqual(api.related("A.md", "parent"), ["B.md"]);
	assert.equal(api.relationships().length, 1);
	live = false;
	assert.deepEqual(api.related("A.md", "parent"), []);
	assert.deepEqual(api.connections("A.md"), []);
	assert.deepEqual(api.relationships(), []);
	assert.deepEqual(api.similar("A.md"), []);
	assert.deepEqual(api.paths("A.md", "B.md"), []);
	assert.equal(api.meaningReady(), false);
	assert.deepEqual(await api.search("anything"), []);
	assert.deepEqual(await api.connect("A.md", "parent", "B.md"), { ok: false, reason: "Relate is not running." });
	assert.deepEqual(await api.disconnect("A.md", "parent", "B.md"), { ok: false, reason: "Relate is not running." });
	assert.equal(connects, 0);
});

/** The contract Relate publishes, checked in so a rename on either side fails a test. */
const contract = JSON.parse(readFileSync(new URL("./contract/relate-api.json", import.meta.url), "utf8")) as {
	version: number;
	events: { ready: string; request: string; unload: string; changed: string };
	methods: string[];
};

test("[integration 3] the event names match the published contract", () => {
	assert.deepEqual(
		{ ready: EVENT_READY, request: EVENT_REQUEST, unload: EVENT_UNLOAD, changed: EVENT_CHANGED },
		contract.events
	);
});

test("[integration 3] the API object is frozen, version 1, with exactly the published methods", () => {
	const api = createApi(fakeDeps());
	assert.equal(Object.isFrozen(api), true);
	assert.equal(api.version, contract.version);
	assert.deepEqual(Object.keys(api).filter((k) => k !== "version").sort(), [...contract.methods].sort());
	for (const m of contract.methods) assert.equal(typeof (api as unknown as Record<string, unknown>)[m], "function", m);
});

/** A workspace event bus in memory, like Obsidian's Events. */
class Bus {
	private handlers = new Map<string, Set<(...data: unknown[]) => unknown>>();
	on(name: string, fn: (...data: unknown[]) => unknown): EventRef {
		const set = this.handlers.get(name) ?? new Set();
		set.add(fn);
		this.handlers.set(name, set);
		return { name, fn };
	}
	offref(ref: EventRef): void {
		const { name, fn } = ref as unknown as { name: string; fn: (...data: unknown[]) => unknown };
		this.handlers.get(name)?.delete(fn);
	}
	trigger(name: string, ...data: unknown[]): void {
		for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...data);
	}
}

/** A consumer written as the family standard asks: listen first, then request. */
function consumer(bus: Bus) {
	const seen: { api: RelateApi | null; readies: number; unloads: number } = { api: null, readies: 0, unloads: 0 };
	bus.on(contract.events.ready, (api) => {
		seen.readies++;
		seen.api = api as RelateApi;
	});
	bus.on(contract.events.unload, () => {
		seen.unloads++;
		seen.api = null;
	});
	bus.trigger(contract.events.request);
	return seen;
}

test("[integration 3] the handshake connects in either load order, and unload ends it", () => {
	// Relate first: a consumer that loads later gets the API in answer to its request.
	const bus = new Bus();
	const api = createApi(fakeDeps());
	const provider = new ApiProvider(bus as unknown as Events, api);
	provider.listen();
	provider.ready();
	const late = consumer(bus);
	assert.equal(late.api, api);

	// Consumer first: its request finds no listener, and Relate's ready reaches it later.
	const bus2 = new Bus();
	const early = consumer(bus2);
	assert.equal(early.api, null);
	const provider2 = new ApiProvider(bus2 as unknown as Events, api);
	const ref = provider2.listen();
	provider2.ready();
	assert.equal(early.api, api);

	// Unload: the consumer drops the API, and later requests go unanswered.
	provider2.unload();
	assert.equal(early.api, null);
	assert.equal(early.unloads, 1);
	bus2.trigger(contract.events.request);
	assert.equal(early.api, null);
	bus2.offref(ref);

	// Reload: a new Relate announces a new API, which the consumer takes.
	const api3 = createApi(fakeDeps());
	const provider3 = new ApiProvider(bus2 as unknown as Events, api3);
	provider3.listen();
	provider3.ready();
	assert.equal(early.api, api3);
});
