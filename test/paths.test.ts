import { test } from "./harness";
import assert from "node:assert/strict";
import { findPaths, type PathGraph } from "../src/paths";
import { chipToText, parseQuery, replaceChip, type NoteRef } from "../src/search/parser";
import { normalizeTitle } from "../src/links";
import { sidesOf } from "../src/settings";
import { baseBlock } from "../src/bases";

/** A tiny graph: links are recorded on one side only, as `from` → `to` under `prop`. */
function graph(links: [string, string, string][]): PathGraph {
	const out = new Map<string, Set<string>>();
	const inc = new Map<string, Set<string>>();
	const add = (m: Map<string, Set<string>>, k: string, v: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
	for (const [from, prop, to] of links) {
		add(out, `${from}|${prop}`, to);
		add(inc, `${to}|${prop}`, from);
	}
	return {
		targets: (p, prop) => out.get(`${p}|${prop}`) ?? new Set(),
		incoming: (p, prop) => inc.get(`${p}|${prop}`) ?? new Set(),
	};
}

const relations = [
	{ property: "home", inverse: "residents", propertyOne: true, inverseOne: false, chains: false },
	{ property: "region", inverse: "places", propertyOne: true, inverseOne: false, chains: true },
	{ property: "member of", inverse: "members", propertyOne: false, inverseOne: false, chains: false },
];
const sides = sidesOf(relations);

const g = graph([
	["Boromir", "home", "Minas Tirith"],
	["Minas Tirith", "region", "Gondor"],
	["Faramir", "home", "Minas Tirith"],
	["Boromir", "member of", "Fellowship"],
	["Fellowship", "members", "Aragorn"],
	["Aragorn", "home", "Minas Tirith"],
]);

test("paths read from the starting note's side, whichever note records the link", () => {
	const [p] = findPaths(g, sides, "Boromir", "Gondor");
	assert.deepEqual(p, [
		{ from: "Boromir", prop: "home", to: "Minas Tirith" },
		{ from: "Minas Tirith", prop: "region", to: "Gondor" },
	]);
	const [back] = findPaths(g, sides, "Gondor", "Boromir");
	assert.deepEqual(back.map((s) => s.prop), ["places", "residents"]);
});

test("paths list the shortest first and keep a route one step longer", () => {
	const ps = findPaths(g, sides, "Boromir", "Aragorn");
	// Two routes of two steps: through the Fellowship and through Minas Tirith.
	assert.equal(ps[0].length, 2);
	assert.deepEqual(new Set(ps.map((p) => p[0].to)), new Set(["Fellowship", "Minas Tirith"]));
	const lens = ps.map((p) => p.length);
	assert.deepEqual([...lens].sort(), lens);
	assert.ok(Math.max(...lens) <= lens[0] + 1);
});

test("paths respect a relationship filter, a step limit and busy notes", () => {
	assert.equal(findPaths(g, sides, "Boromir", "Gondor", { props: new Set(["member of", "members"]) }).length, 0);
	assert.equal(findPaths(g, sides, "Boromir", "Gondor", { maxSteps: 1 }).length, 0);
	// Minas Tirith has four connections; with a limit of three it cannot be passed through.
	assert.equal(findPaths(g, sides, "Boromir", "Gondor", { busy: 3 }).length, 0);
	assert.equal(findPaths(g, sides, "Boromir", "Gondor", { busy: 4 }).length, 1);
	assert.deepEqual(findPaths(g, sides, "Boromir", "Boromir"), []);
});

const NOTES: Record<string, NoteRef> = {
	gondor: { path: "Gondor.md", title: "Gondor" },
	"minas tirith": { path: "Minas Tirith.md", title: "Minas Tirith" },
};
const resolve = (s: string) => NOTES[normalizeTitle(s)] ?? null;
const labels = new Map([
	["residents", "residents"],
	["places", "places"],
	["home", "home"],
]);

test("nested phrases become one chip with every step", () => {
	const q = parseQuery("residents of all places of Gondor stewards", labels, resolve);
	assert.equal(q.chips.length, 1);
	const c = q.chips[0];
	assert.equal(c.kind, "relation");
	if (c.kind !== "relation") return;
	assert.deepEqual(c.chain.map((s) => [s.prop, s.all]), [["residents", false], ["places", true]]);
	assert.equal(c.note.path, "Gondor.md");
	assert.equal(q.text, "stewards");
	assert.equal(chipToText(c), "residents of all places of Gondor");
});

test("a changed chip is written back into the query", () => {
	const query = "residents of Minas Tirith steward";
	const c = parseQuery(query, labels, resolve).chips[0];
	if (c.kind !== "relation") throw new Error("expected a relation chip");
	const changed = chipToText({ ...c, chain: [{ ...c.chain[0], prop: "places", label: "places", all: true }] });
	assert.equal(replaceChip(query, c, changed), "all places of Minas Tirith steward");
	assert.equal(replaceChip(query, c, ""), "steward");
	const again = parseQuery("Minas Tirith's residents", labels, resolve).chips[0];
	assert.equal(again.kind === "relation" && again.chain.length, 1);
});

test("the Bases block reads the other side and quotes safely", () => {
	const side = sides.get("residents")!;
	const block = baseBlock(side);
	assert.ok(block.startsWith("```base\n"));
	assert.ok(block.includes(`'list(note["home"]).filter(value.linksTo(this.file)).length > 0'`));
	const odd = baseBlock({ ...side, prop: "it's", inverse: "o'clock" });
	assert.ok(odd.includes(`'list(note["o''clock"])`));
	assert.ok(odd.includes(`name: 'it''s'`));
});

test("without, folder and tag phrases become chips, and dates still win their own words", () => {
  const folders = (span: string) => (["research/notes", "notes"].includes(span.toLowerCase()) ? "Research/Notes" : null);
  const labels2 = new Map([...labels, ["project", "project"]]);
  const q = parseQuery("without project in Research/Notes #draft pricing", labels2, resolve, new Date(2026, 9, 21), folders);
  assert.deepEqual(
    q.chips.map((c) => [c.kind, c.kind === "missing" ? c.prop : c.kind === "folder" ? c.path : c.kind === "tag" ? c.tag : ""]),
    [["missing", "project"], ["folder", "Research/Notes"], ["tag", "draft"]]
  );
  assert.equal(q.text, "pricing");
  assert.equal(chipToText(q.chips[0]), "without project");
  const d = parseQuery("notes in 2023", labels2, resolve, new Date(2026, 9, 21), () => "2023");
  assert.equal(d.chips[0].kind, "date", "a year is a date, not a folder named 2023");
  const none = parseQuery("in nowhere no home", labels2, resolve, new Date(2026, 9, 21), folders);
  assert.deepEqual(none.chips.map((c) => c.kind), ["missing"]);
  assert.equal(none.text, "in nowhere");
});

test("needs-a-link rules cover a folder or a tag, and a link on either note counts", async () => {
  const { findNeeds, inScope } = await import("../src/health");
  const note = (path: string, tags: string[] = []) => ({ path, tags });
  assert.ok(inScope(note("Research/Notes/a.md"), "Research/Notes"));
  assert.ok(inScope(note("Research/Notes/deep/a.md"), "/Research/Notes/"));
  assert.ok(!inScope(note("Research/Notebook.md"), "Research/Notes"));
  assert.ok(inScope(note("x.md", ["paper/draft"]), "#paper"));
  assert.ok(!inScope(note("x.md", ["papers"]), "#paper"));
  const rel = { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false, required: "Research/Notes" };
  const linked = new Set(["Research/Notes/a.md"]);
  const needs = findNeeds(
    [note("Research/Notes/a.md"), note("Research/Notes/b.md"), note("Characters/c.md")],
    [rel, { ...rel, property: "x", inverse: "y", required: "" }],
    (path) => linked.has(path)
  );
  assert.deepEqual(needs, [{ file: "Research/Notes/b.md", prop: "project", scope: "Research/Notes" }]);
});
