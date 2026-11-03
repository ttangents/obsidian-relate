import assert from "node:assert/strict";
import { test } from "vitest";
import type { App, TAbstractFile } from "obsidian";
import { isVaultNote } from "../src/vault-note";

/** A vault that holds the given files, keyed by path, as Obsidian's does. */
function appWith(...files: TAbstractFile[]): App {
	const byPath = new Map(files.map((f) => [f.path, f]));
	return { vault: { getAbstractFileByPath: (p: string) => byPath.get(p) ?? null } } as unknown as App;
}

function file(path: string): TAbstractFile {
	return { path, extension: path.split(".").pop() } as unknown as TAbstractFile;
}

test("a Markdown note the vault holds counts", () => {
	const note = file("Projects/Atlas.md");
	assert.equal(isVaultNote(appWith(note), note), true);
});

test("a file opened from outside the vault does not count, even at a vault note's path", () => {
	// Obsidian 1.14.4 hands these over as TExternalFile, a TFile the vault does not hold.
	assert.equal(isVaultNote(appWith(file("Atlas.md")), file("/Users/sam/Desktop/readme.md")), false);
	assert.equal(isVaultNote(appWith(file("readme.md")), file("readme.md")), false);
});

test("other file types and nothing do not count", () => {
	const pdf = file("Paper.pdf");
	assert.equal(isVaultNote(appWith(pdf), pdf), false);
	assert.equal(isVaultNote(appWith(), null), false);
	assert.equal(isVaultNote(appWith(), undefined), false);
});
