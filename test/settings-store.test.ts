import { test } from "vitest";
import assert from "node:assert/strict";
import { SettingsStore, mergeHistory, type SettingsIo } from "../src/settings-store";
import type { HistoryBatch } from "../src/settings";

/** A settings file in memory. `disk` is what another device's sync would overwrite. */
function file(initial: unknown): SettingsIo & { disk: unknown } {
	const io = {
		disk: JSON.parse(JSON.stringify(initial)) as unknown,
		load: async () => JSON.parse(JSON.stringify(io.disk)) as unknown,
		save: async (data: unknown) => {
			io.disk = JSON.parse(JSON.stringify(data)) as unknown;
		},
	};
	return io;
}

const batch = (id: string, time: number, undoable = true): HistoryBatch => ({ id, time, label: id, ops: [], undoable });
const parent = { property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true };
const project = { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false };

test("[review 1] settings that arrive by sync are taken in, and the next save keeps them", async () => {
	const io = file({ relations: [parent], history: [batch("here", 1)] });
	const store = new SettingsStore(io);
	await store.load();
	const settings = store.settings;

	// Another device adds a relationship, records a change, and syncs its copy of the file.
	io.disk = { relations: [parent, project], history: [batch("there", 2)], semantic: { enabled: true } };
	const change = await store.reload();
	assert.deepEqual(change, { relations: true, meaning: true });
	assert.equal(store.settings, settings, "the settings object stays the same, so every service sees the change");
	assert.deepEqual(settings.relations.map((r) => r.property), ["parent", "project"]);
	assert.deepEqual(settings.history.map((b) => b.id), ["here", "there"], "history from both devices is kept");

	// A later change on this device saves without losing the other device's work.
	settings.autoSync = false;
	await store.save();
	const saved = io.disk as { relations: { property: string }[]; history: { id: string }[]; autoSync: boolean };
	assert.deepEqual(saved.relations.map((r) => r.property), ["parent", "project"]);
	assert.deepEqual(saved.history.map((b) => b.id), ["here", "there"]);
	assert.equal(saved.autoSync, false);
});

test("[review 1] a copy with problems, such as a half-synced file, is ignored", async () => {
	const io = file({ relations: [parent] });
	const store = new SettingsStore(io);
	await store.load();
	io.disk = { relations: "not a list" };
	assert.equal(await store.reload(), null);
	assert.deepEqual(store.settings.relations.map((r) => r.property), ["parent"]);
});

test("[review 1] a reload that changes nothing that matters reports no change", async () => {
	const io = file({ relations: [parent] });
	const store = new SettingsStore(io);
	await store.load();
	io.disk = { relations: [parent], panelClosed: true };
	assert.deepEqual(await store.reload(), { relations: false, meaning: false });
	assert.equal(store.settings.panelClosed, true);
});

test("[review 1] a batch undone on either device stays undone after a merge", () => {
	const merged = mergeHistory([batch("a", 1), batch("b", 2, false)], [batch("a", 1, false), batch("b", 2), batch("c", 3)]);
	assert.deepEqual(
		merged.map((b) => [b.id, b.undoable]),
		[
			["a", false],
			["b", false],
			["c", true],
		]
	);
});
