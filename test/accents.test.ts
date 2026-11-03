import assert from "node:assert/strict";
import { test } from "vitest";
import { LexicalIndex, foldAccents, tokenize } from "../src/search/lexical";

test("Latin and Greek accents fold away, as in Obsidian's own search since 1.15", () => {
	assert.deepEqual(tokenize("Café Zürich naïve Ångström"), ["cafe", "zurich", "naive", "angstrom"]);
	assert.equal(foldAccents("ά έ ή"), "α ε η");
});

test("other scripts keep their marks", () => {
	assert.equal(foldAccents("हिन्दी"), "हिन्दी");
	assert.equal(foldAccents("한국어"), "한국어");
});

test("a search without accents finds a note with them, and the other way round", () => {
	const idx = new LexicalIndex();
	idx.set("a.md", "Café notes", "Meeting at the café in Zürich");
	idx.set("b.md", "Plain", "Nothing about coffee here");
	assert.deepEqual(idx.search("cafe zurich", null).map((h) => h.path), ["a.md"]);
	assert.deepEqual(idx.search("Zürich", null).map((h) => h.path), ["a.md"]);
});
