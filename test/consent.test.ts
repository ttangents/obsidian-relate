import { test } from "vitest";
import assert from "node:assert/strict";
import { Consent, meaningPlan } from "../src/semantic/consent";
import { DEFAULT_SEMANTIC, type SemanticSettings } from "../src/settings";

function device() {
	const store = new Map<string, unknown>();
	return new Consent({ load: (k) => store.get(k) ?? null, save: (k, v) => void store.set(k, v) }, "model@1");
}

const server = (url: string): SemanticSettings => ({ ...DEFAULT_SEMANTIC, enabled: true, source: "server", serverUrl: url, serverModel: "m" });

test("[review 4] a server address that arrives by sync needs this device's own agreement", () => {
	const consent = device();
	assert.deepEqual(meaningPlan(server("http://box:11434"), consent), { kind: "ask-server", url: "http://box:11434" });
	consent.allowServer("http://box:11434");
	assert.deepEqual(meaningPlan(server(" http://box:11434 "), consent), { kind: "start" });
});

test("[review 4] agreeing to one address agrees to no other, including a half-typed one", () => {
	const consent = device();
	consent.allowServer("http://localhost:11434");
	assert.equal(consent.server("http://localhost:1143"), false);
	assert.equal(consent.server("http://other:11434"), false);
	assert.equal(consent.server(""), false);
	assert.deepEqual(meaningPlan(server("http://localhost:1143"), consent), { kind: "ask-server", url: "http://localhost:1143" });
});

test("[review 4] the built-in model needs agreement once per device, and forgetting asks again", () => {
	const consent = device();
	const builtin: SemanticSettings = { ...DEFAULT_SEMANTIC, enabled: true };
	assert.deepEqual(meaningPlan(builtin, consent), { kind: "ask-model" });
	consent.allowModel();
	assert.deepEqual(meaningPlan(builtin, consent), { kind: "start" });
	consent.forgetModel();
	assert.deepEqual(meaningPlan(builtin, consent), { kind: "ask-model" });
});

test("[review 4] a server without an address or model cannot start", () => {
	assert.deepEqual(meaningPlan({ ...server(""), serverModel: "" }, device()), { kind: "needs-address" });
});

test("[review 7] a device that cannot keep the model asks before every download", () => {
	const consent = device();
	consent.allowModel();
	assert.deepEqual(meaningPlan({ ...DEFAULT_SEMANTIC, enabled: true }, consent, true), { kind: "ask-model" });
});
