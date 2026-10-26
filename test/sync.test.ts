import { test } from "vitest";
import assert from "node:assert/strict";
import { FakeApp, FakeFiles, TFile } from "./fake-obsidian";
import { EdgeIndex, traverse } from "../src/graph";
import { Writer } from "../src/writer";
import { SyncEngine, TIMING, type SyncHost } from "../src/sync";
import type { App, TFile as ObsidianFile } from "obsidian";
import { computeHealth, MapEdges, nothingToFix } from "../src/health";
import { SearchService, type SearchHost } from "../src/search/service";
import { History } from "../src/history";
import { DEFAULT_SETTINGS, normalizeSettings, sidesOf, type Relation, type RelateSettings, type Side } from "../src/settings";
TIMING.settle = 5;
TIMING.retries = [20, 20, 20];

function setup(relations: Relation[], notes: Record<string, Record<string, unknown>>, opts: { start?: boolean } = {}) {
	const app = new FakeApp();
	for (const [p, fm] of Object.entries(notes)) app.add(p, fm);
	// The fake stands in for the slice of Obsidian's App that Relate uses.
	const obsidian = app as unknown as App;
	const settings: RelateSettings = { ...DEFAULT_SETTINGS, relations };
	const errors: string[] = [];
	const sides = () => sidesOf(settings.relations);
	const notices: string[] = [];
	const history = new History({
		files: new FakeFiles(),
		path: "history.json",
		reverse: (label, ops) => plugin.sync.undo(label, ops),
		notify: (message) => notices.push(message),
		reportError: (where, e) => errors.push(`${where}: ${String(e)}`),
	});
	const host: SyncHost = {
		app: obsidian,
		settings,
		sides,
		index: new EdgeIndex(obsidian, () => new Set(sides().keys())),
		writer: new Writer(obsidian),
		history,
		refreshViews: () => {},
		relationsValid: () => true,
		registerEvent: () => {},
		reportError: (where: string, e: unknown) => {
			errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
			return String(e);
		},
	};
	const plugin = { ...host, sync: new SyncEngine(host) };
	if (opts.start !== false) plugin.sync.start();
	app.onChanged((file: TFile) => plugin.sync.onChanged(real(file)));
	const batches = () => history.list();
	return { app, plugin, settings, errors, history, notices, batches };
}

const family: Relation = { property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true };
const related: Relation = { property: "related", inverse: "related", propertyOne: false, inverseOne: false, chains: false };
const spouse: Relation = { property: "spouse", inverse: "spouse", propertyOne: true, inverseOne: true, chains: false };
const side = (plugin: Pick<SyncHost, "sides">, prop: string): Side => {
	const found = plugin.sides().get(prop);
	if (!found) throw new Error(`no relationship side named ${prop}`);
	return found;
};
/** A fake note, typed as the Obsidian file it stands in for. */
const real = (file: TFile) => file as unknown as ObsidianFile;
const f = (app: FakeApp, p: string): ObsidianFile => {
	const file = app.files.get(p);
	if (!file) throw new Error(`no fake note at ${p}`);
	return real(file);
};

// ---------------------------------------------------------------- mirroring

test("adding a child writes the parent on the other note", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": { title: "kept" } });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md"), { title: "kept", parent: "[[A]]" });
});

test("a second parent moves the child and cleans up the old parent", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": {}, "C.md": {} });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	await app.edit("C.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[C]]");
	assert.equal(app.fm.get("A.md")!.children, undefined);
	assert.deepEqual(app.fm.get("C.md")!.children, ["[[B]]"]);
});

test("removing a link removes the other side; other values stay", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": {}, "D.md": {} });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]", "[[D]]"]));
	await app.settle();
	await app.edit("A.md", (fm) => (fm.children = ["[[D]]"]));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, undefined);
	assert.equal(app.fm.get("D.md")!.parent, "[[A]]");
});

test("an older one-way link is left for Check links", async () => {
	const { app } = setup([related], { "A.md": {}, "B.md": { related: "[[X]]" }, "X.md": {} });
	await app.edit("A.md", (fm) => (fm.related = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md")!.related, ["[[X]]", "[[A]]"]);
	assert.equal(app.fm.get("X.md")!.related, undefined);
});

test("auto-sync off leaves other notes alone", async () => {
	const { app, settings } = setup([family], { "A.md": {}, "B.md": {} });
	settings.autoSync = false;
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md"), {});
});

test("half-typed YAML is ignored rather than read as removals", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": {}, "C.md": {} });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]", "[[C]]"]));
	await app.settle();
	app.breakYaml("A.md");
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
	assert.equal(app.fm.get("C.md")!.parent, "[[A]]");
});

test("rapid competing claims on a two-way only-one property leave exactly one consistent pair", async () => {
	const { app, plugin } = setup([spouse], { "A.md": {}, "B.md": {}, "C.md": {} });
	await app.edit("A.md", (fm) => (fm.spouse = "[[B]]"));
	await app.edit("C.md", (fm) => (fm.spouse = "[[B]]"));
	await app.settle();
	const b = app.fm.get("B.md")!.spouse;
	assert.ok(b === "[[A]]" || b === "[[C]]", `B has ${JSON.stringify(b)}`);
	const [winner, loser] = b === "[[A]]" ? ["A.md", "C.md"] : ["C.md", "A.md"];
	assert.equal(app.fm.get(winner)!.spouse, "[[B]]");
	assert.equal(app.fm.get(loser)!.spouse, undefined, "the losing claim is removed");
	assert.equal(plugin.sync.health().missing.length + plugin.sync.health().conflicts.length, 0);
});

test("only-one replacement keeps plain text and unresolved links", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": { parent: ["TBD", "[[Ghost]]"] } });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md")!.parent, ["TBD", "[[Ghost]]", "[[A]]"]);
});

test("links to non-note files are never written to", async () => {
	const { app } = setup([family], { "A.md": {}, "pic.png": {} });
	app.files.get("pic.png")!.extension = "png";
	await app.edit("A.md", (fm) => (fm.children = ["[[pic.png]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("pic.png"), {});
});

test("renaming with stale links does not drain the renamed note", async () => {
	const { app, plugin } = setup([family], { "A.md": { children: ["[[B]]"] }, "B.md": { parent: "[[A]]" } });
	const b = app.files.get("B.md")!;
	for (const m of [app.fm, app.cache]) {
		m.set("B2.md", m.get("B.md")!);
		m.delete("B.md");
	}
	app.files.delete("B.md");
	b.path = "B2.md";
	app.files.set("B2.md", b);
	plugin.index.rename("B.md", "B2.md");
	plugin.sync.onRename("B.md", "B2.md");
	await app.edit("A.md", (fm) => (fm.status = "edited"));
	await app.settle();
	assert.equal(app.fm.get("B2.md")!.parent, "[[A]]");
});

// ---------------------------------------------------------------- review findings

test("[review 3] undo right after a large batch removes every link, even while the cache lags", async () => {
	const project: Relation = { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false };
	const names = Array.from({ length: 40 }, (_, i) => `N${i}.md`);
	const notesFm: Record<string, Record<string, unknown>> = { "Paper.md": {} };
	for (const n of names) notesFm[n] = {};
	const { app, plugin, batches, history } = setup([project], notesFm);
	app.cacheLag = 200;
	const notes = side(plugin, "notes");
	await plugin.sync.connectMany(names.map((n) => ({ file: f(app, "Paper.md"), side: notes, target: f(app, n) })), "Linked 40 notes to Paper");
	// Undo at once, before Obsidian has re-read the notes Relate just wrote.
	await history.undo(batches().at(-1)!.id);
	await app.settle();
	assert.equal(app.fm.get("Paper.md")!.notes, undefined);
	for (const n of names) assert.equal(app.fm.get(n)!.project, undefined, n);
	assert.equal(batches().at(-2)!.undoable, false);
});

test("[review 3] a link removed and quickly added again is mirrored again, even while the cache lags", async () => {
	const { app } = setup([related], { "A.md": { related: ["[[B]]"] }, "B.md": { related: ["[[A]]"] } });
	app.lag.set("B.md", 400);
	await app.edit("A.md", (fm) => delete fm.related);
	for (let i = 0; i < 100 && app.fm.get("B.md")!.related !== undefined; i++) await new Promise((r) => setTimeout(r, 2));
	assert.equal(app.fm.get("B.md")!.related, undefined, "Relate removed the back-link");
	// The user puts the link back before Obsidian has re-read B.
	await app.edit("A.md", (fm) => (fm.related = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md")!.related, ["[[A]]"]);
});

test("[review 14] a back-link that is already in the file is never written twice, even while the cache lags", async () => {
	const { app, plugin } = setup([related], { "A.md": {}, "B.md": {} });
	app.cacheLag = 100;
	await plugin.sync.connect(f(app, "A.md"), side(plugin, "related"), f(app, "B.md"));
	// Another device's identical write arrives before Obsidian re-reads B.
	await plugin.sync.connect(f(app, "A.md"), side(plugin, "related"), f(app, "B.md"));
	await app.settle();
	assert.deepEqual(app.fm.get("A.md")!.related, ["[[B]]"]);
	assert.deepEqual(app.fm.get("B.md")!.related, ["[[A]]"]);
});

test("[review 2] a mirrored move can be undone, and undo puts all three notes back", async () => {
	const { app, batches, history, notices } = setup([family], { "A.md": { children: ["[[B]]"] }, "B.md": { parent: "[[A]]" }, "C.md": {} });
	await app.edit("C.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[C]]");
	assert.equal(app.fm.get("A.md")!.children, undefined);
	const batch = batches().at(-1)!;
	assert.equal(batch.undoable, true, "a mirrored change is undoable");
	assert.deepEqual(batch.ops[0], { path: "C.md", prop: "children", target: "B.md", action: "add" }, "the user's own edit leads the batch");
	await history.undo(batch.id);
	await app.settle();
	assert.equal(app.fm.get("C.md")!.children, undefined);
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
	assert.deepEqual(app.fm.get("A.md")!.children, ["[[B]]"]);
	assert.equal(batch.undoable, false);
	assert.ok(notices.at(-1)!.startsWith("Relate undid"));
});

test("[review 2] undoing part of a mirrored batch leaves the rest undoable", async () => {
	const { app, batches, history } = setup([related], { "A.md": { related: ["[[B]]", "[[C]]"] }, "B.md": { related: ["[[A]]"] }, "C.md": { related: ["[[A]]"] } });
	await app.edit("A.md", (fm) => (fm.related = []));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.related, undefined);
	assert.equal(app.fm.get("C.md")!.related, undefined);
	const batch = batches().at(-1)!;
	const forB = batch.ops.filter((op) => op.path === "B.md" || op.target === "B.md");
	await history.undo(batch.id, forB);
	await app.settle();
	assert.deepEqual(app.fm.get("A.md")!.related, ["[[B]]"]);
	assert.deepEqual(app.fm.get("B.md")!.related, ["[[A]]"]);
	assert.equal(app.fm.get("C.md")!.related, undefined, "the other removal stays");
	assert.equal(batch.undoable, true);
	assert.match(batch.label, /partly undone/);
});

test("[1] a user edit to a note Relate just wrote is still mirrored", async () => {
	const { app } = setup([related], { "A.md": {}, "B.md": {}, "C.md": {} });
	// When Relate writes A into B, the user adds C to B before Relate has seen its own write come back.
	const original = app.fileManager.processFrontMatter;
	let interfered = false;
	app.fileManager.processFrontMatter = async (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
		await original(file, fn);
		if (file.path === "B.md" && !interfered) {
			interfered = true;
			await original(file, (fm) => (fm.related = [...((fm.related as string[]) ?? []), "[[C]]"]));
		}
	};
	await app.edit("A.md", (fm) => (fm.related = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md")!.related, ["[[A]]", "[[C]]"]);
	assert.deepEqual(app.fm.get("C.md")!.related, ["[[B]]"], "C gets its backlink");
});

test("[2] a batch that fails partway records what it changed and says it stopped", async () => {
	const { app, plugin, batches } = setup([family], { "A.md": { children: ["[[B]]", "[[C]]"] }, "B.md": {}, "C.md": {} });
	const h = plugin.sync.health();
	assert.equal(h.missing.length, 2);
	app.failWrites.add("C.md");
	const out = await plugin.sync.repair(h.missing);
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
	assert.equal(out.applied.length, 1);
	assert.ok(out.error?.includes("could not save C.md"));
	const batch = batches().at(-1)!;
	assert.ok(batch.label.includes("stopped partway"));
	assert.equal(batch.undoable, true);
	assert.equal(batch.ops.length, 1);
});

test("[2] a failed mirror is retried instead of forgotten", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": {} });
	app.failWrites.add("B.md");
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	await new Promise((r) => setTimeout(r, 120));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
});

test("[3] Check links flags an only-one property with two links even when both are reciprocal", () => {
	const { plugin } = setup([family], {
		"A.md": { parent: ["[[B]]", "[[C]]"] },
		"B.md": { children: ["[[A]]"] },
		"C.md": { children: ["[[A]]"] },
	});
	const h = plugin.sync.health();
	assert.equal(h.missing.length, 0);
	assert.equal(h.conflicts.length, 1);
	assert.deepEqual(h.conflicts[0].current, ["B.md", "C.md"]);
	assert.equal(h.conflicts[0].via, "children");
});

test("[3] resolving a two-parent note removes the other parent on both sides", async () => {
	const { app, plugin } = setup([family], {
		"A.md": { parent: ["[[B]]", "[[C]]"] },
		"B.md": { children: ["[[A]]"] },
		"C.md": { children: ["[[A]]"] },
	});
	const out = await plugin.sync.resolve(plugin.sync.health().conflicts[0], "B.md");
	await app.settle();
	assert.equal(out.error, null);
	assert.deepEqual(app.fm.get("A.md")!.parent, ["[[B]]"]);
	assert.equal(app.fm.get("C.md")!.children, undefined);
});

test("[4] a stale repair proposal is skipped, not applied", async () => {
	const { app, plugin } = setup([related], { "A.md": { related: ["[[B]]"] }, "B.md": {} });
	const plan = plugin.sync.health().missing;
	assert.equal(plan.length, 1);
	plugin.sync.pause();
	await app.edit("A.md", (fm) => delete fm.related);
	await app.settle();
	plugin.sync.resume();
	const out = await plugin.sync.repair(plan);
	await app.settle();
	assert.equal(app.fm.get("B.md")!.related, undefined);
	assert.equal(out.applied.length, 0);
	assert.equal(out.skipped.length, 1);
});

test("[4] a conflict choice made on stale information changes nothing", async () => {
	const { app, plugin } = setup([spouse], { "A.md": { spouse: "[[B]]" }, "B.md": {}, "C.md": { spouse: "[[B]]" } });
	const conflict = plugin.sync.health().conflicts[0];
	plugin.sync.pause();
	await app.edit("C.md", (fm) => delete fm.spouse);
	await app.settle();
	plugin.sync.resume();
	const out = await plugin.sync.resolve(conflict, "C.md");
	await app.settle();
	assert.ok(out.error);
	assert.equal(out.applied.length, 0);
	assert.equal(app.fm.get("A.md")!.spouse, "[[B]]");
});

test("[5] an edit right after startup is mirrored", async () => {
	const { app } = setup([family], { "A.md": {}, "B.md": {} });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
});

test("[5] changes seen before Obsidian finishes reading the vault become the baseline, and later edits are mirrored", async () => {
	const { app, plugin } = setup([family], { "A.md": {}, "B.md": {}, "D.md": {} }, { start: false });
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]"]));
	await app.settle();
	assert.deepEqual(app.fm.get("B.md"), {}, "nothing is written before startup finishes");
	plugin.sync.start();
	await app.edit("A.md", (fm) => (fm.children = ["[[B]]", "[[D]]"]));
	await app.settle();
	assert.equal(app.fm.get("D.md")!.parent, "[[A]]", "an edit after startup is mirrored at once");
	assert.equal(plugin.sync.health().missing.length, 1, "the pre-startup link shows up in Check links");
});

test("[6] stopping cancels work that was already queued", async () => {
	const { app, plugin } = setup([related], { "A.md": {}, "B.md": {} });
	const pending = plugin.sync.connect(f(app, "A.md"), side(plugin, "related"), f(app, "B.md"));
	plugin.sync.stop();
	await pending;
	await app.settle();
	assert.deepEqual(app.fm.get("A.md"), {});
	assert.deepEqual(app.fm.get("B.md"), {});
});

test("[7] undo keeps what it could not reverse, so it can be tried again", async () => {
	const { app, plugin } = setup([related], { "A.md": { related: ["[[B]]"] }, "B.md": { related: ["[[A]]"] } });
	const out = await plugin.sync.disconnect(f(app, "A.md"), side(plugin, "related"), "B.md");
	await app.settle();
	assert.equal(out.applied.length, 2);
	// B disappears before the user undoes.
	app.files.delete("B.md");
	const result = await plugin.sync.undo("Unlinked", out.applied);
	assert.ok(result.unresolved.length >= 1);
	assert.ok(result.reasons.some((r: string) => r.includes("no longer exists")));
});

test("[7] undo restores an alias exactly", async () => {
	const { app, plugin } = setup([family], { "A.md": { children: ["[[B]]"] }, "B.md": { parent: "[[A|The A]]" } });
	const out = await plugin.sync.disconnect(f(app, "B.md"), side(plugin, "parent"), "A.md");
	await app.settle();
	assert.equal(app.fm.get("B.md")!.parent, undefined);
	assert.equal(app.fm.get("A.md")!.children, undefined);
	const result = await plugin.sync.undo("Unlinked", out.applied);
	await app.settle();
	assert.equal(result.unresolved.length, 0);
	assert.equal(app.fm.get("B.md")!.parent, "[[A|The A]]");
	assert.deepEqual(app.fm.get("A.md")!.children, ["[[B]]"]);
});

test("[8] removing from the panel updates both notes even with auto-sync off", async () => {
	const { app, plugin, settings } = setup([related], { "A.md": { related: ["[[B]]"] }, "B.md": { related: ["[[A]]"] } });
	settings.autoSync = false;
	await plugin.sync.disconnect(f(app, "A.md"), side(plugin, "related"), "B.md");
	await app.settle();
	assert.equal(app.fm.get("A.md")!.related, undefined);
	assert.equal(app.fm.get("B.md")!.related, undefined);
});

test("[8] linking writes both notes even with auto-sync off", async () => {
	const { app, plugin, settings } = setup([family], { "A.md": {}, "B.md": {} });
	settings.autoSync = false;
	await plugin.sync.connect(f(app, "A.md"), side(plugin, "children"), f(app, "B.md"));
	await app.settle();
	assert.deepEqual(app.fm.get("A.md")!.children, ["[[B]]"]);
	assert.equal(app.fm.get("B.md")!.parent, "[[A]]");
});

test("[9] chains are followed only when the relationship allows it, and truncation is reported", () => {
	const graph: Record<string, string[]> = { A: ["B"], B: ["C"], C: ["D"] };
	const step = (p: string) => new Set(graph[p] ?? []);
	assert.deepEqual([...traverse("A", step, false, 12).paths], ["B"]);
	assert.deepEqual([...traverse("A", step, true, 12).paths].sort(), ["B", "C", "D"]);
	const capped = traverse("A", step, true, 2);
	assert.deepEqual([...capped.paths].sort(), ["B", "C"]);
	assert.equal(capped.truncated, true);
});

test("[10] text search retries after a failed read", async () => {
	const { app } = setup([], { "A.md": {}, "B.md": {} });
	// Only what text search touches.
	const plugin = { app, index: { hasEdges: () => false }, semantic: { ready: false } } as unknown as SearchHost;
	const search = new SearchService(plugin);
	app.failReads.add("A.md");
	await search.ensureBuilt();
	assert.equal(search.lexical.size, 1);
	await search["flush"]();
	assert.equal(search.lexical.size, 2, "the failed note is read again");
	search.stop();

	const broken = new SearchService(plugin);
	const files = app.vault.getMarkdownFiles;
	let calls = 0;
	app.vault.getMarkdownFiles = () => {
		if (calls++ === 0) throw new Error("vault not ready");
		return files();
	};
	await assert.rejects(broken.ensureBuilt());
	await broken.ensureBuilt();
	assert.equal(broken.lexical.size, 2, "a failed build is tried again");
	broken.stop();
});

test("[UX] linking into a property that already breaks its only-one rule explains why nothing changed", async () => {
	const { app, plugin } = setup([family], { "A.md": {}, "B.md": { parent: ["[[C]]", "[[D]]"] }, "C.md": {}, "D.md": {} });
	const out = await plugin.sync.connect(f(app, "B.md"), side(plugin, "parent"), f(app, "A.md"));
	assert.equal(out.applied.length, 0);
	assert.ok(out.skipped[0].includes("more than one parent"));
});

test("[settings] a damaged settings file falls back to safe values and says what was wrong", () => {
	const { settings, problems } = normalizeSettings({ relations: [{ property: "parent", inverse: "children" }, { property: 3 }], autoSync: "yes", history: "x" });
	assert.equal(settings.relations.length, 1);
	assert.equal(settings.autoSync, true);
	assert.equal(problems.length, 2);
	assert.equal(normalizeSettings(undefined).problems.length, 0);
});

test("health is the same planner used for previews", () => {
	const edges = new Map([["A.md", new Map([["children", new Set(["B.md", "C.md"])]])]]);
	const h = computeHealth(new MapEdges(edges), sidesOf([family]));
	assert.deepEqual(h.missing.map((m) => m.file).sort(), ["B.md", "C.md"]);
});

// ---------------------------------------------------------------- 0.3: linking, loops, setups

const region: Relation = { property: "region", inverse: "places", propertyOne: true, inverseOne: false, chains: true };

test("Check links finds a loop in a hierarchy, once", () => {
	const { plugin } = setup([region], {
		"Bag End.md": { region: "[[Hobbiton]]" },
		"Hobbiton.md": { region: "[[Shire]]" },
		"Shire.md": { region: "[[Bag End]]" },
	});
	const loops = plugin.sync.health().loops;
	assert.equal(loops.length, 1);
	assert.equal(loops[0].prop, "region");
	assert.equal(loops[0].path.length, 4);
	assert.equal(loops[0].path[0], loops[0].path[3]);
});

test("linking refuses to close a loop and explains the chain", async () => {
	const { app, plugin } = setup([region], {
		"Bag End.md": { region: "[[Hobbiton]]" },
		"Hobbiton.md": { region: "[[Shire]]", places: ["[[Bag End]]"] },
		"Shire.md": { places: ["[[Hobbiton]]"] },
	});
	const out = await plugin.sync.connect(f(app, "Shire.md"), side(plugin, "region"), f(app, "Bag End.md"));
	await app.settle();
	assert.equal(out.applied.length, 0);
	assert.ok(out.skipped[0].includes("loop back"));
	assert.ok(out.skipped[0].includes("Shire → Bag End → Hobbiton → Shire"));
	assert.equal(app.fm.get("Shire.md")!.region, undefined);
	// Linking downwards from the top is fine.
	const ok = await plugin.sync.connect(f(app, "Bag End.md"), side(plugin, "region"), f(app, "Hobbiton.md"));
	assert.equal(ok.skipped.length, 1, "already linked");
});

test("linking several notes is one undoable batch, and skips only the pairs that cannot be linked", async () => {
	const { app, plugin, batches } = setup([{ property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false }], {
		"Paper.md": {},
		"A.md": {},
		"B.md": {},
		"C.md": {},
	});
	const notes = side(plugin, "notes");
	const out = await plugin.sync.connectMany(
		["A.md", "B.md", "C.md"].map((p) => ({ file: f(app, "Paper.md"), side: notes, target: f(app, p) })),
		"Linked 3 notes to Paper"
	);
	await app.settle();
	assert.deepEqual(app.fm.get("Paper.md")!.notes, ["[[A]]", "[[B]]", "[[C]]"]);
	for (const p of ["A.md", "B.md", "C.md"]) assert.deepEqual(app.fm.get(p)!.project, ["[[Paper]]"]);
	assert.equal(batches().filter((h) => h.undoable).length, 1);
	const undo = await plugin.sync.undo("Linked 3 notes to Paper", out.applied);
	await app.settle();
	assert.equal(undo.unresolved.length, 0);
	assert.equal(app.fm.get("Paper.md")!.notes, undefined);
	assert.equal(app.fm.get("B.md")!.project, undefined);
});

test("common setups exclude any whose property names are already in use", async () => {
	const { availablePresets, PRESETS, validateRelations } = await import("../src/settings");
	const left = availablePresets([family]);
	assert.ok(!left.some((p) => p.relation.property === "parent"));
	assert.equal(left.length, PRESETS.length - 1);
	assert.equal(validateRelations(PRESETS.map((p) => p.relation)).length, 0, "the presets never clash with each other");
});

test("a needs-a-link rule lists notes without the link until they get one", async () => {
  const rule: Relation = { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false, required: "Research" };
  const { app, plugin } = setup([rule], { "Research/A.md": {}, "Research/B.md": { project: "[[Paper]]" }, "Other.md": {}, "Paper.md": { notes: "[[B]]" } });
  await app.settle();
  assert.deepEqual(plugin.sync.health().needs.map((n) => n.file), ["Research/A.md"]);
  assert.equal(nothingToFix(plugin.sync.health()), false, "[review 9] a note that needs a link keeps Check links open");
  await plugin.sync.connect(f(app, "Research/A.md"), side(plugin, "project"), f(app, "Paper.md"));
  await app.settle();
  assert.deepEqual(plugin.sync.health().needs, []);
  assert.equal(nothingToFix(plugin.sync.health()), true);
});
