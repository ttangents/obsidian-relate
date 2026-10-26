// The tests run in Node against a small fake of Obsidian's API, which stands in for the "obsidian" module.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: { obsidian: fileURLToPath(new URL("./test/fake-obsidian.ts", import.meta.url)) } },
	test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
});
