import { test } from "vitest";
import assert from "node:assert/strict";
import { extraPanels } from "../src/panels";

test("one panel or none leaves nothing to close", () => {
	assert.deepEqual(extraPanels([], () => true), []);
	assert.deepEqual(extraPanels(["a"], () => false), []);
});

test("with two panels and none in view, the first stays", () => {
	assert.deepEqual(extraPanels(["a", "b"], () => false), ["b"]);
});

test("the panel in view stays, even when it is not the first", () => {
	assert.deepEqual(extraPanels(["a", "b", "c"], (p) => p === "b"), ["a", "c"]);
});

test("when several are in view, the first of them stays", () => {
	assert.deepEqual(extraPanels(["a", "b", "c"], (p) => p !== "a"), ["a", "c"]);
});
