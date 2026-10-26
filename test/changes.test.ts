import { afterEach, beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { FakeApp } from "./fake-obsidian";
import { ChangeSignal } from "../src/api";
import { EdgeIndex } from "../src/graph";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

test("[review 21] relate:changed goes out once a burst settles, and only when something changed", () => {
	let state = "1";
	let sent = 0;
	const signal = new ChangeSignal(() => sent++, () => state);
	signal.poke();
	signal.poke();
	vi.advanceTimersByTime(200);
	assert.equal(sent, 1, "one burst, one event");
	signal.poke();
	vi.advanceTimersByTime(200);
	assert.equal(sent, 1, "nothing changed, so nothing is sent");
	state = "2";
	signal.poke();
	vi.advanceTimersByTime(200);
	assert.equal(sent, 2);
	signal.stop();
	state = "3";
	signal.poke();
	vi.advanceTimersByTime(200);
	assert.equal(sent, 2, "nothing after unload");
});

test("[review 21] the link index reports its own changes, whatever caused them", () => {
	const fake = new FakeApp();
	const a = fake.add("A.md", { related: ["[[B]]"] });
	fake.add("B.md");
	// The fake stands in for the slice of Obsidian's App that the index uses.
	const index = new EdgeIndex(fake as unknown as App, () => new Set(["related"]));
	let calls = 0;
	const stop = index.onChange(() => calls++);
	index.rebuild();
	assert.equal(calls, 1);
	fake.cache.set("A.md", { related: [] });
	index.update(a as unknown as Parameters<EdgeIndex["update"]>[0]);
	assert.equal(calls, 2);
	index.update(a as unknown as Parameters<EdgeIndex["update"]>[0]);
	assert.equal(calls, 2, "an update that changes no link is not a change");
	stop();
	index.delete("B.md");
	assert.equal(calls, 2);
});
