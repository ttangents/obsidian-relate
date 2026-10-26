import { test } from "vitest";
import assert from "node:assert/strict";
import { SettingsStore, type SettingsIo } from "../src/settings-store";
import { mergeHistory } from "../src/history";
import type { HistoryBatch } from "../src/settings";
import { FakeFiles } from "./fake-obsidian";

const DATA = "plugins/relate/data.json";
const BACKUP = "plugins/relate/data.backup.json";

/**
 * A settings file in memory, as Obsidian's loadData and saveData see it. `disk` is what another device's sync
 * would overwrite; `text` sets the file's exact text instead, as a damaged file would have.
 */
function file(initial: unknown): SettingsIo & { disk: unknown; text(t: string): void; files: FakeFiles } {
	const files = new FakeFiles();
	const io = {
		files,
		dataPath: DATA,
		backupPath: BACKUP,
		get disk(): unknown {
			const t = files.data.get(DATA);
			return t === undefined ? null : (JSON.parse(t) as unknown);
		},
		set disk(value: unknown) {
			files.data.set(DATA, JSON.stringify(value));
		},
		text: (t: string) => void files.data.set(DATA, t),
		// Like Obsidian, null for a missing file and for one that does not parse.
		load: async (): Promise<unknown> => {
			try {
				return io.disk;
			} catch {
				return null;
			}
		},
		save: async (data: unknown) => {
			io.disk = JSON.parse(JSON.stringify(data)) as unknown;
		},
	};
	if (initial !== undefined) io.disk = initial;
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
	assert.deepEqual(store.legacyHistory.map((b) => b.id), ["here", "there"], "history from both devices is kept until it moves to its own file");

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

test("[review 13] a settings file that does not parse is backed up before the first save, and is not a first run", async () => {
	const io = file(undefined);
	io.text('{"relations": [{"property": "parent", "inverse": "chil');
	const store = new SettingsStore(io);
	await store.load();
	assert.deepEqual(store.problems, ["The settings file was not readable."]);
	assert.equal(store.settings.welcomed, true, "a vault that had settings never gets the first-run welcome again");
	await store.save();
	assert.equal(io.files.data.get(BACKUP), '{"relations": [{"property": "parent", "inverse": "chil');
	assert.equal((io.disk as { welcomed: boolean }).welcomed, true);
});

test("[review 13] a relationship dropped as malformed survives in the backup", async () => {
	const original = { relations: [{ property: "parent", inverse: "children" }, { property: 3 }] };
	const io = file(original);
	const store = new SettingsStore(io);
	await store.load();
	assert.equal(store.problems.length, 1);
	await store.save();
	assert.deepEqual(JSON.parse(io.files.data.get(BACKUP) ?? "null"), original);
});

test("[review 13] when the backup cannot be written, the damaged original stays untouched", async () => {
	const io = file(undefined);
	io.text("{oops");
	const store = new SettingsStore(io);
	await store.load();
	io.files.failWrites.add(BACKUP);
	await assert.rejects(store.save());
	assert.equal(io.files.data.get(DATA), "{oops");
});

test("[review 13] a missing settings file is a first run, unless a backup shows the vault had settings", async () => {
	const fresh = new SettingsStore(file(undefined));
	await fresh.load();
	assert.deepEqual(fresh.problems, []);
	assert.equal(fresh.settings.welcomed, false);

	const io = file(undefined);
	io.files.data.set(BACKUP, "{}");
	const restored = new SettingsStore(io);
	await restored.load();
	assert.equal(restored.settings.welcomed, true);
});
