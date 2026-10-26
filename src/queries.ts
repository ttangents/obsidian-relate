import { traverse } from "./graph";
import { stepsFrom, type PathGraph, type Step } from "./paths";
import type { Side } from "./settings";

/** Deepest chain that following a relationship walks, such as places within places. */
const MAX_CHAIN_DEPTH = 12;

/** Questions about relationships, answered from the link index. Reads only; writes nothing. */
export class RelationQueries {
	constructor(private index: PathGraph, private sides: () => Map<string, Side>) {}

	/** Notes related to `path` through `prop`, whichever note records the link. */
	related(path: string, prop: string, all: boolean): Set<string> {
		return this.relatedDetail(path, prop, all).paths;
	}

	/**
	 * Notes related to `path` through `prop`. With `all`, follows chains only when the relationship allows it,
	 * and says whether it followed them and whether it stopped at the depth limit.
	 */
	relatedDetail(path: string, prop: string, all: boolean): { paths: Set<string>; followed: boolean; truncated: boolean } {
		const side = this.sides().get(prop);
		const step = (p: string) => {
			const out = new Set(this.index.targets(p, prop));
			if (side) for (const q of this.index.incoming(p, side.inverse)) out.add(q);
			out.delete(p);
			return out;
		};
		const follow = all && !!side?.chains;
		const r = traverse(path, step, follow, MAX_CHAIN_DEPTH);
		return { paths: r.paths, followed: follow, truncated: r.truncated };
	}

	/** Every note linked to `path` through any relationship. */
	connected(path: string): Set<string> {
		const out = new Set<string>();
		for (const side of this.sides().values()) {
			for (const p of this.index.targets(path, side.prop)) out.add(p);
			for (const p of this.index.incoming(path, side.prop)) out.add(p);
		}
		out.delete(path);
		return out;
	}

	/** Every relationship of the note at `path`, named from its side, whichever note records the link. */
	connections(path: string): Step[] {
		return stepsFrom(this.index, this.sides(), path);
	}
}
