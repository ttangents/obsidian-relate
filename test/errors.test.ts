import { test } from "vitest";
import assert from "node:assert/strict";
import { ErrorLog, type ErrorEntry } from "../src/errors";
import { insecureRemote } from "../src/semantic/consent";

test("[review 22] the same error is recorded once a minute at most, so a down server cannot flood the settings file", () => {
	let now = 0;
	let saves = 0;
	const settings = { errors: [] as ErrorEntry[] };
	const log = new ErrorLog({ settings, save: () => saves++ }, () => now);
	const quiet = console.error;
	console.error = () => {};
	try {
		for (let i = 0; i < 20; i++) assert.equal(log.report("Search by meaning", new Error("connect ECONNREFUSED")), "connect ECONNREFUSED");
		assert.equal(saves, 1);
		log.report("Updating the meaning index", new Error("connect ECONNREFUSED"));
		assert.equal(saves, 2, "another place is another error");
		now = 61_000;
		log.report("Search by meaning", new Error("connect ECONNREFUSED"));
		assert.equal(saves, 3, "a minute later it is recorded again");
		for (let i = 0; i < 10; i++) log.report(`place ${i}`, "x");
		assert.equal(settings.errors.length, 5, "the file keeps the five newest");
	} finally {
		console.error = quiet;
	}
});

test("[review 22] plain http to another machine counts as unencrypted; this device and https do not", () => {
	assert.equal(insecureRemote("http://box.lan:11434"), true);
	assert.equal(insecureRemote("http://192.168.1.5:1234/v1"), true);
	assert.equal(insecureRemote("http://localhost:11434"), false);
	assert.equal(insecureRemote("http://127.0.0.1:1234"), false);
	assert.equal(insecureRemote("http://[::1]:1234"), false);
	assert.equal(insecureRemote("https://box.lan"), false);
	assert.equal(insecureRemote("not a url"), false);
});
