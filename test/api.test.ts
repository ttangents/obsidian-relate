import { test } from "vitest";
import assert from "node:assert/strict";
import { createApi, type ApiDeps } from "../src/api";
import { sidesOf } from "../src/settings";

/** An API over an empty vault that records what it was asked. */
function fakeDeps(over: Partial<ApiDeps> = {}): ApiDeps & { limits: number[] } {
	const limits: number[] = [];
	const relations = [{ property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true }];
	const deps: ApiDeps & { limits: number[] } = {
		limits,
		index: { targets: () => new Set(), incoming: () => new Set() },
		sides: () => sidesOf(relations),
		relations: () => relations,
		queries: { related: () => new Set(["B.md"]), connections: () => [{ from: "A.md", prop: "parent", to: "B.md" }] },
		search: async () => [],
		semantic: {
			ready: true,
			similar: (_path, limit) => {
				limits.push(limit);
				return [{ path: "B.md", score: 0.9 }];
			},
		},
		note: () => null,
		connect: async () => ({ applied: [], skipped: [], error: null }),
		disconnect: async () => ({ applied: [], skipped: [], error: null }),
		changed: () => {},
		...over,
	};
	return deps;
}

test("[review 21] similar keeps its limit between 1 and 50, like paths", () => {
	const deps = fakeDeps();
	const api = createApi(deps);
	api.similar("A.md", 1000);
	api.similar("A.md", -3);
	api.similar("A.md");
	assert.deepEqual(deps.limits, [50, 1, 5]);
});
