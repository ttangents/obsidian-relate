import { test } from "vitest";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { FakeApp } from "./fake-obsidian";
import { previewRelations, scanProperties } from "../src/adopt";

function vault(notes: Record<string, Record<string, unknown>>): App {
	const app = new FakeApp();
	for (const [p, fm] of Object.entries(notes)) app.add(p, fm);
	// The fake stands in for the slice of Obsidian's App that the scan uses.
	return app as unknown as App;
}

test("the vault scan offers properties that link notes, most used first, and counts what it left out", () => {
	const app = vault({
		"A.md": { project: "[[P]]", up: "[[B]]", pic: "[[img.png]]" },
		"B.md": { project: ["[[P]]", "[[Q]]"] },
		"C.md": { up: "[[A]]", once: "[[A]]" },
		"P.md": {},
		"Q.md": {},
	});
	const scan = scanProperties(app, new Set(["up"]));
	assert.deepEqual(scan.candidates.map((c) => [c.prop, c.notes, c.links]), [["project", 2, 3]]);
	assert.equal(scan.candidates[0].relation.inverse, "notes");
	assert.equal(scan.hiddenRare, 1, "a property used in one note is left out");
	assert.equal(scan.hiddenMore, 0);
});

test("the preview of adopting a relationship counts the links it would add, without writing", () => {
	const app = vault({ "A.md": { project: "[[P]]" }, "B.md": { project: "[[P]]" }, "P.md": {} });
	const rel = { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false };
	assert.deepEqual(previewRelations(app, [rel]), { links: 2, notes: 1, choices: 0 });
});
