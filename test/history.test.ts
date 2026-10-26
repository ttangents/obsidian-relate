import { test } from "vitest";
import assert from "node:assert/strict";
import { FakeFiles } from "./fake-obsidian";
import { History, MAX_BATCH_SIZE, MAX_HISTORY_SIZE } from "../src/history";
import { SettingsStore } from "../src/settings-store";
import type { HistoryBatch, HistoryOp } from "../src/settings";

const PATH = "plugins/relate/history.json";

function setup(files = new FakeFiles()) {
	const notices: string[] = [];
	const errors: string[] = [];
	const reversed: HistoryOp[][] = [];
	const history = new History({
		files,
		path: PATH,
		reverse: async (_label, ops) => {
			reversed.push(ops);
			return { done: ops.length, unresolved: [], reasons: [] };
		},
		notify: (m) => notices.push(m),
		reportError: (where, e) => errors.push(`${where}: ${String(e)}`),
	});
	return { history, files, notices, errors, reversed };
}

const op = (i: number): HistoryOp => ({ path: `Notes/Note number ${i}.md`, prop: "project", target: "Projects/Paper.md", action: "add" });
const batch = (id: string, time: number, ops: HistoryOp[] = [op(1)]): HistoryBatch => ({ id, time, label: id, ops, undoable: true });
const onDisk = (files: FakeFiles) => JSON.parse(files.data.get(PATH) ?? "[]") as HistoryBatch[];

test("[review 6] history from an earlier version moves out of the settings file without loss", async () => {
	const settingsFile = { disk: { relations: [], autoSync: true, history: [batch("old", 1)] } as unknown };
	const store = new SettingsStore({
		load: async () => settingsFile.disk,
		save: async (d) => void (settingsFile.disk = JSON.parse(JSON.stringify(d)) as unknown),
		files: new FakeFiles(),
		dataPath: "data.json",
		backupPath: "data.backup.json",
	});
	await store.load();
	assert.deepEqual(store.legacyHistory.map((b) => b.id), ["old"]);
	const { history, files } = setup();
	assert.equal(await history.load(store.legacyHistory), true);
	assert.deepEqual(onDisk(files).map((b) => b.id), ["old"], "the history file has it before the settings drop it");
	store.legacyHistory = [];
	await store.save();
	assert.equal((settingsFile.disk as { history?: unknown }).history, undefined, "the settings file no longer carries history");

	// The next start finds it in the history file only, once.
	const again = setup(files);
	await again.history.load([]);
	assert.deepEqual(again.history.list().map((b) => b.id), ["old"]);
});

test("[review 6] when the history file cannot be written, the settings file keeps the old history", async () => {
	const files = new FakeFiles();
	files.failWrites.add(PATH);
	const { history, errors } = setup(files);
	assert.equal(await history.load([batch("old", 1)]), false);
	assert.equal(errors.length, 1);
});

test("[review 6] a batch too large to keep for undo says so, and keeps its count", async () => {
	const { history, notices } = setup();
	await history.load();
	const many = Array.from({ length: 12000 }, (_, i) => op(i));
	assert.ok(JSON.stringify(many).length > MAX_BATCH_SIZE);
	history.record("Linked 12000 notes", many, true);
	const b = history.list().at(-1)!;
	assert.equal(b.undoable, false);
	assert.equal(b.ops.length, 0);
	assert.equal(b.count, 12000);
	assert.match(notices[0], /too many to keep for undo/);
});

test("[review 6] the history file stays under its size limit, dropping the oldest batches first", async () => {
	const { history, files } = setup();
	await history.load();
	const big = Array.from({ length: 5000 }, (_, i) => op(i));
	for (let i = 0; i < 6; i++) history.record(`batch ${i}`, big, true);
	await history.flush();
	const saved = onDisk(files);
	assert.ok((files.data.get(PATH) ?? "").length <= MAX_HISTORY_SIZE);
	assert.ok(saved.length < 6);
	assert.equal(saved.at(-1)!.label, "batch 5", "the newest batch stays");
});

test("[review 6] a save keeps batches another device wrote to the history file meanwhile", async () => {
	const files = new FakeFiles();
	const here = setup(files);
	await here.history.load();
	here.history.record("here", [op(1)], true);
	// Sync brings the other device's copy of the file before this device saves.
	files.data.set(PATH, JSON.stringify([batch("there", 1)]));
	await here.history.flush();
	assert.deepEqual(onDisk(files).map((b) => b.label).sort(), ["here", "there"]);
});

test("[review 6] a change recorded while a save is under way is not lost", async () => {
	const { history, files } = setup();
	await history.load();
	history.record("first", [op(1)], true);
	const saving = history.flush();
	history.record("second", [op(2)], true);
	await saving;
	await history.flush();
	assert.deepEqual(onDisk(files).map((b) => b.label), ["first", "second"]);
});
