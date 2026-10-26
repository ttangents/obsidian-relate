import { test } from "vitest";
import assert from "node:assert/strict";
import { FakeApp, network } from "./fake-obsidian";
import { SemanticIndex, type SemanticHost } from "../src/semantic/index";
import { Consent } from "../src/semantic/consent";
import { DEFAULT_SETTINGS, type RelateSettings } from "../src/settings";
import type { App } from "obsidian";

function setup(semantic: Partial<RelateSettings["semantic"]>) {
	const app = new FakeApp();
	app.add("A.md");
	app.add("B.md");
	const settings: RelateSettings = { ...DEFAULT_SETTINGS, semantic: { ...DEFAULT_SETTINGS.semantic, enabled: true, ...semantic } };
	const errors: string[] = [];
	// The fake stands in for the slice of Obsidian's App that the index uses.
	const host: SemanticHost = { app: app as unknown as App, settings, reportError: (where, e) => (errors.push(`${where}: ${String(e)}`), String(e)) };
	const consent = new Consent({ load: (k) => app.loadLocalStorage(k), save: (k, v) => app.saveLocalStorage(k, v) }, "model@1");
	const index = new SemanticIndex(host, consent);
	return { app, index, consent, errors };
}

test("[review 4] a server address this device has not agreed to receives nothing", async () => {
	network.requests.length = 0;
	network.reply = null;
	const { index } = setup({ source: "server", serverUrl: "http://box:11434" });
	await index.start();
	assert.equal(index.status.state, "needs-consent");
	assert.match(index.status.message, /http:\/\/box:11434/);
	assert.equal(network.requests.length, 0);
	index.stop();
});

test("[review 4] once this device agrees to the address, notes go there and nowhere else", async () => {
	network.requests.length = 0;
	network.reply = (_url, body) => ({ data: (JSON.parse(body ?? "{}") as { input: string[] }).input.map((_, i) => ({ index: i, embedding: [1, i] })) });
	const { index, consent } = setup({ source: "server", serverUrl: "http://box:11434" });
	consent.allowServer("http://box:11434");
	await index.start();
	assert.equal(index.status.state, "ready");
	assert.ok(network.requests.length > 0);
	assert.ok(network.requests.every((r) => r.url === "http://box:11434/v1/embeddings"));
	index.stop();
	network.reply = null;
});
