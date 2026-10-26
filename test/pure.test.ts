import { test } from "vitest";
import assert from "node:assert/strict";
import { parseQuery, removeChip, type NoteRef } from "../src/search/parser";
import { findDate } from "../src/search/dates";
import { LexicalIndex, tokenize } from "../src/search/lexical";
import { keyBelongsTo, normalizeTitle, parseWikilink, stripLeadingTag } from "../src/links";
import { sidesOf, suggestInverse, validateRelations } from "../src/settings";

const NOTES: Record<string, NoteRef> = {
	"agentic architecture 2026": { path: "(Project) Agentic Architecture 2026.md", title: "(Project) Agentic Architecture 2026" },
	"project agentic architecture 2026": { path: "(Project) Agentic Architecture 2026.md", title: "(Project) Agentic Architecture 2026" },
	atlas: { path: "Atlas.md", title: "Atlas" },
};
const resolve = (s: string) => NOTES[normalizeTitle(s)] ?? null;
const labels = new Map([
	["children", "children"],
	["parent", "parent"],
	["part of", "part_of"],
	["notes", "notes"],
]);
const NOW = new Date(2026, 9, 21, 15, 0, 0); // 21 Oct 2026

test("relation phrase with the note title", () => {
	const q = parseQuery("children of Atlas", labels, resolve, NOW);
	assert.equal(q.chips.length, 1);
	const c = q.chips[0];
	assert.equal(c.kind, "relation");
	if (c.kind === "relation") {
		assert.equal(c.prop, "children");
		assert.equal(c.note.path, "Atlas.md");
		assert.equal(c.all, false);
	}
	assert.equal(q.text, "");
});

test("relation phrase keeps the remaining words for text search", () => {
	const q = parseQuery("notes of Agentic Architecture 2026 about governance", labels, resolve, NOW);
	const c = q.chips[0];
	assert.equal(c.kind, "relation");
	if (c.kind === "relation") assert.equal(c.note.path, "(Project) Agentic Architecture 2026.md");
	assert.equal(q.text, "about governance");
});

test("possessive form and multi-word labels with underscores", () => {
	const q = parseQuery("Atlas's part of", labels, resolve, NOW);
	assert.equal(q.chips[0].kind, "relation");
	const r = parseQuery("part_of of Atlas pricing", labels, resolve, NOW);
	const c = r.chips[0];
	assert.ok(c.kind === "relation" && c.prop === "part_of");
	assert.equal(r.text, "pricing");
});

test("all … of follows chains; colon form works", () => {
	const q = parseQuery("all children of Atlas", labels, resolve, NOW);
	assert.ok(q.chips[0].kind === "relation" && q.chips[0].all);
	const c = parseQuery("parent: Atlas", labels, resolve, NOW);
	assert.ok(c.chips[0].kind === "relation" && c.chips[0].prop === "parent");
});

test("an unknown note leaves the phrase as plain text", () => {
	const q = parseQuery("children of nobody here", labels, resolve, NOW);
	assert.equal(q.chips.length, 0);
	assert.equal(q.text, "children of nobody here");
});

test("connected to, dates, and removing a chip", () => {
	const query = "connected to Atlas pricing last month";
	const q = parseQuery(query, labels, resolve, NOW);
	assert.deepEqual(q.chips.map((c) => c.kind), ["connected", "date"]);
	assert.equal(q.text, "pricing");
	assert.equal(removeChip(query, q.chips[1]), "connected to Atlas pricing");
	assert.equal(removeChip(query, q.chips[0]), "pricing last month");
});

test("date phrases", () => {
	const lm = findDate("from last month", NOW)!;
	assert.equal(new Date(lm.from).getMonth(), 8);
	assert.equal(new Date(lm.to).getMonth(), 9);
	assert.equal(lm.start, 0);
	const tw = findDate("this week", NOW)!;
	assert.equal(new Date(tw.from).getDay(), 1);
	const n = findDate("in the last 3 days", NOW)!;
	assert.equal(Math.round((NOW.getTime() - n.from) / 86400000), 3);
	const ym = findDate("in 2026-09", NOW)!;
	assert.equal(new Date(ym.from).getMonth(), 8);
	assert.equal(new Date(ym.to).getMonth(), 9);
	const y = findDate("notes from 2025", NOW)!;
	assert.equal(new Date(y.from).getFullYear(), 2025);
	assert.equal(findDate("Agentic Architecture 2026", NOW), null);
	assert.ok(findDate("since 2026-10-01", NOW));
});

test("lexical ranking, title weight, prefix while typing, and filters", () => {
	const idx = new LexicalIndex();
	idx.set("a.md", "Governance model", "how agents are governed and audited");
	idx.set("b.md", "Pricing", "governance appears once here among many other words about pricing tiers");
	idx.set("c.md", "Kitchen", "potatoes");
	const hits = idx.search("governance", null);
	assert.equal(hits[0].path, "a.md");
	assert.equal(hits.length, 2);
	assert.equal(idx.search("potat", null)[0].path, "c.md");
	assert.deepEqual(idx.search("governance", new Set(["b.md"])).map((h) => h.path), ["b.md"]);
	idx.rename("a.md", "z.md");
	assert.equal(idx.search("governance model", null)[0].path, "z.md");
	idx.remove("z.md");
	assert.equal(idx.search("model", null).length, 0);
	assert.deepEqual(tokenize("The AI-agent of 2026"), ["ai", "agent", "2026"]);
});

test("link helpers", () => {
	assert.equal(parseWikilink("[[Atlas]]"), "Atlas");
	assert.equal(parseWikilink("[[Folder/Atlas|A]]"), "Folder/Atlas");
	assert.equal(parseWikilink("[[Atlas#Heading]]"), "Atlas");
	assert.equal(parseWikilink("Atlas"), null);
	assert.equal(stripLeadingTag("(Project) Atlas"), "Atlas");
	assert.ok(keyBelongsTo("children.3", "children"));
	assert.ok(keyBelongsTo("children", "children"));
	assert.ok(!keyBelongsTo("childrenx", "children"));
	assert.ok(!keyBelongsTo("children.x", "children"));
});

test("relationship settings", () => {
	const sides = sidesOf([
		{ property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true },
		{ property: "related", inverse: "related", propertyOne: false, inverseOne: false, chains: false },
	]);
	assert.equal(sides.size, 3);
	assert.equal(sides.get("children")!.inverse, "parent");
	assert.equal(sides.get("children")!.inverseOne, true);
	assert.equal(sides.get("related")!.inverse, "related");
	assert.equal(
		validateRelations([
			{ property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: false },
			{ property: "children", inverse: "up", propertyOne: false, inverseOne: false, chains: false },
		]).length,
		1
	);
	assert.equal(suggestInverse("related").inverse, "related");
	assert.equal(suggestInverse("parent").inverse, "children");
	assert.equal(suggestInverse("topic").inverse, "topic of");
});

import { fuse, rank, readableText, fingerprint } from "../src/semantic/core";
import { ServerEmbedder } from "../src/semantic/embedders";

test("rank keeps hits close to the best and respects the pool", () => {
	const v = (...x: number[]) => Float32Array.from(x);
	const vectors = new Map([
		["a", v(1, 0)],
		["b", v(0.8, 0.6)],
		["c", v(0, 1)],
	]);
	assert.deepEqual(rank(v(1, 0), vectors, null, 10, 0.1, 0.6).map((h) => h.path), ["a", "b"]);
	assert.deepEqual(rank(v(1, 0), vectors, ["b", "c"], 10, 0.1, 0.6).map((h) => h.path), ["b"]);
});

test("fusion lifts notes ranked well in either list", () => {
	const f = fuse([["a", "b", "c"], ["c", "d"]]);
	const order = [...f].sort((x, y) => y[1] - x[1]).map(([p]) => p);
	assert.equal(order[0], "c");
	assert.ok(order.includes("d"));
});

test("readable text drops markup and keeps meaning-bearing properties", () => {
	const t = readableText("Gollum", { summary: "Sméagol, ruined by five centuries with the Ring.", home: "[[Misty Mountains]]", year: "1954" }, "See [[Frodo Baggins|Frodo]] and ![[x.jpg]] at https://x.y\n## Notes\n- [ ] task");
	assert.ok(t.includes("Sméagol, ruined"));
	assert.ok(t.includes("See Frodo and"));
	assert.ok(!t.includes("[[") && !t.includes("https") && !t.includes("Misty"));
	assert.notEqual(fingerprint("a"), fingerprint("b"));
});

test("server embedder finds the endpoint and normalises vectors", async () => {
	const calls: string[] = [];
	const e = new ServerEmbedder("http://localhost:11434/", "m", "k", async (url, body, headers) => {
		calls.push(url + " " + headers.Authorization);
		const n = (JSON.parse(body) as { input: string[] }).input.length;
		return { data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [3, 4] })) };
	});
	const out = await e.embed(["x", "y"]);
	assert.equal(calls[0], "http://localhost:11434/v1/embeddings Bearer k");
	assert.ok(Math.abs(out[0]![0] - 0.6) < 1e-6);
	assert.equal(new ServerEmbedder("https://a.b/v1", "m", null, async () => ({})).id.startsWith("server:m@"), true);
});

test("a re-stamped date does not change what gets embedded", async () => {
  const { readableText, fingerprint } = await import("../src/semantic/core");
  const body = "The Ring tempts everyone who carries it.";
  const a = readableText("Ring", { modified: "2026-10-21T07:51:00+08:00", summary: "A study of how the Ring works on its bearers" }, body);
  const b = readableText("Ring", { modified: "2026-10-22T09:12:44.123Z", summary: "A study of how the Ring works on its bearers" }, body);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.ok(a.includes("A study of how the Ring"), "real text in properties still counts");
});

test("release notes match the manifest and announce only what is unseen", async () => {
  const { RELEASE_NOTES, RELEASE_GROUPS, compareVersions, unseenNotes, laterVersion, COMPANION } = await import("../src/release-notes");
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { version: string };
  assert.equal(RELEASE_NOTES[0].version, manifest.version);
  for (const [i, n] of RELEASE_NOTES.entries()) {
    assert.ok(n.headline.endsWith("."));
    const items = [...RELEASE_GROUPS.flatMap((g) => n[g.key] ?? []), ...(n.withCompanion ?? [])];
    assert.ok(items.length > 0);
    for (const item of items) assert.ok(/[.)"]$/.test(item), item);
    const next = RELEASE_NOTES[i + 1];
    if (next) assert.ok(compareVersions(n.version, next.version) > 0);
  }
  assert.deepEqual(unseenNotes(manifest.version, manifest.version), [], "nothing after the current version");
  assert.deepEqual(
    unseenNotes(manifest.version, "").map((n) => n.version),
    RELEASE_NOTES.filter((n) => n.announce).map((n) => n.version),
    "an update from before notes existed announces every release that announces itself"
  );
  assert.deepEqual(unseenNotes("0.0.1", ""), [], "never a release newer than the one installed");
  assert.equal(laterVersion("0.5.0", "0.10.0"), "0.10.0");
  assert.match(COMPANION.url, /^https:\/\/community\.obsidian\.md\/plugins\//);
});

test("manifest, package and versions agree, in the form the directory requires", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  const manifest = read("manifest.json") as { id: string; name: string; version: string; minAppVersion: string; description: string; isDesktopOnly: boolean };
  assert.equal(read("package.json").version, manifest.version);
  assert.equal(read("versions.json")[manifest.version], manifest.minAppVersion);
  for (const field of [manifest.id, manifest.name, manifest.description]) assert.ok(!/obsidian|plugin/i.test(field), field);
  assert.match(manifest.description, /^[A-Z][a-z]+ .*\.$/);
  assert.ok(manifest.description.length < 250);
  assert.equal(manifest.isDesktopOnly, false);
});

test("[review 16] one plural and one basename serve every module", async () => {
	const { plural, basename } = await import("../src/links");
	assert.equal(plural(1, "note", "notes"), "1 note");
	assert.equal(plural(3, "note", "notes"), "3 notes");
	assert.equal(basename("Projects/Atlas.md"), "Atlas");
	assert.equal(basename("Atlas.md"), "Atlas");
});
