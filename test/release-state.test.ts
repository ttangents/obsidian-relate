import { test } from "vitest";
import assert from "node:assert/strict";
import { ReleaseState } from "../src/release-state";
import { RELEASE_NOTES } from "../src/release-notes";

function state(version: string, lastShownVersion: string, local: string | null = null) {
	const store = new Map<string, unknown>(local ? [["relate-release-seen", local]] : []);
	const settings = { showReleaseNotes: true, lastShownVersion };
	let saves = 0;
	const s = new ReleaseState({ version, storage: { load: (k) => store.get(k) ?? null, save: (k, v) => void store.set(k, v) }, settings, save: () => saves++ });
	return { s, settings, store, saves: () => saves };
}

test("a new install announces nothing and records the version on both markers", () => {
	const { s, settings, store } = state("1.0.1", "");
	s.review(true);
	assert.deepEqual(s.notes, []);
	assert.equal(settings.lastShownVersion, "1.0.1");
	assert.equal(store.get("relate-release-seen"), "1.0.1");
});

test("this device's marker wins over an older synced one", () => {
	const { s, settings } = state("1.0.1", "0.1.0", "1.0.1");
	s.review(false);
	assert.deepEqual(s.notes, []);
	assert.equal(settings.lastShownVersion, "1.0.1");
});

test("dismissing queued notes marks them seen once", () => {
	const announced = RELEASE_NOTES.find((n) => n.announce);
	const { s, saves } = state("1.0.1", "0.0.1");
	s.notes = announced ? [announced] : [RELEASE_NOTES[0]];
	assert.equal(s.dismiss(), true);
	assert.equal(s.dismiss(), false);
	assert.equal(saves(), 1);
});
