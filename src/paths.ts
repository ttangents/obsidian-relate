import type { Side } from "./settings";

/** One step in an explanation: `from` lists `to` under `prop`, or `to` lists `from` back under the other side. */
export interface Step {
	from: string;
	prop: string;
	to: string;
}

/** Read access to relationship links, in both directions. */
export interface PathGraph {
	targets(path: string, prop: string): ReadonlySet<string>;
	incoming(path: string, prop: string): ReadonlySet<string>;
}

export interface PathOptions {
	/** Only follow these properties, named from the side of the note being left. All when empty. */
	props?: Set<string>;
	/** Longest path, in steps. */
	maxSteps?: number;
	/** How many paths to return. */
	limit?: number;
	/** Notes with more connections than this are not passed through, so busy hub notes do not crowd the answer. */
	busy?: number | null;
}

/** Every step out of `path`, named from `path`'s side. A link recorded on either note counts. */
export function stepsFrom(g: PathGraph, sides: Map<string, Side>, path: string, props?: Set<string>): Step[] {
	const out: Step[] = [];
	const seen = new Set<string>();
	for (const side of sides.values()) {
		if (props?.size && !props.has(side.prop)) continue;
		const add = (to: string) => {
			const key = `${side.prop}\u0000${to}`;
			if (to === path || seen.has(key)) return;
			seen.add(key);
			out.push({ from: path, prop: side.prop, to });
		};
		for (const t of g.targets(path, side.prop)) add(t);
		for (const t of g.incoming(path, side.inverse)) add(t);
	}
	return out;
}

/** Notes with a step into `path` under an allowed property, named from their side. */
function stepsInto(g: PathGraph, sides: Map<string, Side>, path: string, props?: Set<string>): Set<string> {
	const out = new Set<string>();
	for (const side of sides.values()) {
		if (props?.size && !props.has(side.prop)) continue;
		for (const p of g.incoming(path, side.prop)) out.add(p);
		for (const p of g.targets(path, side.inverse)) out.add(p);
	}
	out.delete(path);
	return out;
}

/**
 * Short paths between two notes, shortest first. Finds the shortest length, then lists other simple paths of that
 * length or one step longer, so an alternative route that says something different is not hidden.
 */
export function findPaths(g: PathGraph, sides: Map<string, Side>, from: string, to: string, opts: PathOptions = {}): Step[][] {
	if (from === to) return [];
	const maxSteps = opts.maxSteps ?? 4;
	const limit = opts.limit ?? 5;
	const busy = opts.busy ?? null;
	const cache = new Map<string, Step[]>();
	const next = (p: string) => {
		let s = cache.get(p);
		if (!s) cache.set(p, (s = stepsFrom(g, sides, p, opts.props)));
		return s;
	};
	const passable = (p: string) => p === to || busy === null || new Set(next(p).map((s) => s.to)).size <= busy;

	// Distances from the target, so the search below only walks towards it.
	const dist = new Map<string, number>([[to, 0]]);
	let frontier = [to];
	for (let d = 1; d <= maxSteps && frontier.length; d++) {
		const nxt: string[] = [];
		for (const p of frontier) {
			if (p !== to && !passable(p)) continue;
			for (const q of stepsInto(g, sides, p, opts.props)) {
				if (dist.has(q)) continue;
				dist.set(q, d);
				nxt.push(q);
			}
		}
		frontier = nxt;
	}
	const shortest = dist.get(from);
	if (shortest === undefined) return [];
	const bound = Math.min(maxSteps, shortest + 1);

	const paths: Step[][] = [];
	const onPath = new Set<string>([from]);
	let budget = 20000;
	const walk = (p: string, acc: Step[]) => {
		if (paths.length >= limit * 4 || --budget <= 0) return;
		for (const s of next(p)) {
			if (onPath.has(s.to)) continue;
			const left = dist.get(s.to);
			if (left === undefined || acc.length + 1 + left > bound) continue;
			if (s.to === to) {
				paths.push([...acc, s]);
				continue;
			}
			if (!passable(s.to)) continue;
			onPath.add(s.to);
			walk(s.to, [...acc, s]);
			onPath.delete(s.to);
		}
	};
	walk(from, []);
	return paths.sort((a, b) => a.length - b.length).slice(0, limit);
}
