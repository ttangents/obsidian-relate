import type { Relation, Side } from "./settings";

/** Read access to relationship links: what each note lists under each property. */
export interface EdgeView {
	entries(): Iterable<[string, string, string]>;
	targets(path: string, prop: string): ReadonlySet<string>;
}

/** A link recorded on one note only: `target` lists `file` under `via`, and `file` lacks `prop`. */
export interface Missing {
	/** Note that lacks the link. */
	file: string;
	prop: string;
	/** Note the link should point to. */
	target: string;
	/** The property on `target` that already records the link. */
	via: string;
}

/** A property that holds only one link, with more than one note in or claiming the spot. */
export interface Conflict {
	file: string;
	prop: string;
	/** Notes the property lists now. More than one is itself a problem. */
	current: string[];
	/** Notes that list `file` under `via` but are not listed back. */
	claimants: string[];
	via: string;
}

/** A chain that leads back to where it started, such as a place inside itself. */
export interface Loop {
	/** The property followed upwards, such as "parent" or "region". */
	prop: string;
	/** The notes in order, with the first repeated at the end. */
	path: string[];
}

/** A note that a rule says needs a link in `prop`, and has none. */
export interface Need {
	file: string;
	prop: string;
	/** The rule's scope, as written: "Research/Notes" or "#paper". */
	scope: string;
}

/** Everything Check links reports about the vault. */
export interface Health {
	missing: Missing[];
	conflicts: Conflict[];
	loops: Loop[];
	needs: Need[];
}

/** True when Check links has nothing to show: no one-way link, choice, loop or note that needs a link. */
export function nothingToFix(h: Health): boolean {
	return !h.missing.length && !h.conflicts.length && !h.loops.length && !h.needs.length;
}

/** A note as the rules see it: where it is, and its tags without "#". */
export interface NoteFacts {
	path: string;
	tags: string[];
}

/** Whether a note falls under a rule's scope: a folder and everything below it, or a tag and its nested tags. */
export function inScope(note: NoteFacts, scope: string): boolean {
	const s = scope.trim();
	if (s.startsWith("#")) {
		const want = s.slice(1).toLowerCase();
		return !!want && note.tags.some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(`${want}/`));
	}
	const folder = s.replace(/^\/+|\/+$/g, "");
	return !!folder && note.path.startsWith(`${folder}/`);
}

/** Notes that a "needs a link" rule covers and that have no link in that property, recorded on either note. */
export function findNeeds(notes: Iterable<NoteFacts>, relations: Relation[], hasLink: (path: string, prop: string, inverse: string) => boolean): Need[] {
	const out: Need[] = [];
	const rules = relations.filter((r) => r.required?.trim() && r.property.trim() && r.inverse.trim());
	if (!rules.length) return out;
	for (const note of notes) {
		for (const r of rules) {
			const scope = r.required ?? "";
			if (inScope(note, scope) && !hasLink(note.path, r.property, r.inverse)) out.push({ file: note.path, prop: r.property, scope });
		}
	}
	return out;
}

/**
 * Finds one-way links and broken "only one" rules. The two checks are independent:
 * a property can break its "only one" rule even when every link is recorded on both notes.
 * Never proposes removing a link, and never picks between rival notes.
 */
export function computeHealth(view: EdgeView, sides: Map<string, Side>, only?: Set<string>): Health {
	const missing: Missing[] = [];
	const slots = new Map<string, { file: string; prop: string; via: string; claimants: Set<string> }>();
	const slot = (file: string, prop: string, via: string) => {
		const key = `${file}\u0000${prop}`;
		let s = slots.get(key);
		if (!s) slots.set(key, (s = { file, prop, via, claimants: new Set() }));
		return s;
	};
	const seen = new Set<string>();
	const counted = new Set<string>();

	for (const [src, prop, tgt] of view.entries()) {
		const side = sides.get(prop);
		if (!side || src === tgt) continue;
		if (only && !only.has(prop) && !only.has(side.inverse)) continue;

		// Rule 1: an "only one" property that lists several notes.
		const own = `${src}\u0000${prop}`;
		if (side.one && !counted.has(own)) {
			counted.add(own);
			if (view.targets(src, prop).size > 1) slot(src, prop, side.inverse);
		}

		// Rule 2: a link recorded on one note only.
		if (view.targets(tgt, side.inverse).has(src)) continue;
		const key = `${tgt}\u0000${side.inverse}\u0000${src}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (side.inverseOne) slot(tgt, side.inverse, prop).claimants.add(src);
		else missing.push({ file: tgt, prop: side.inverse, target: src, via: prop });
	}

	const conflicts: Conflict[] = [];
	for (const s of slots.values()) {
		const current = [...view.targets(s.file, s.prop)].sort();
		const claimants = [...s.claimants].filter((c) => !current.includes(c)).sort();
		if (current.length === 0 && claimants.length === 1) {
			missing.push({ file: s.file, prop: s.prop, target: claimants[0], via: s.via });
		} else if (current.length + claimants.length > 1) {
			conflicts.push({ file: s.file, prop: s.prop, current, claimants, via: s.via });
		}
	}
	return { missing, conflicts, loops: [], needs: [] };
}

/**
 * For a chain-following relationship, the notes one step "up" from `path`: what it lists under the property,
 * plus notes that list it under the other side. For parent and children, that is the note's parents.
 */
export function upStep(view: EdgeView, incoming: (path: string, prop: string) => ReadonlySet<string>, r: Relation, path: string): Set<string> {
	const out = new Set(view.targets(path, r.property));
	for (const p of incoming(path, r.inverse)) out.add(p);
	out.delete(path);
	return out;
}

/** The chain from `from` up to `to`, if `to` is above `from`. Used to refuse a link that would close a loop. */
export function pathUp(step: (p: string) => ReadonlySet<string>, from: string, to: string, maxDepth = 64): string[] | null {
	const prev = new Map<string, string>([[from, ""]]);
	let frontier = [from];
	for (let d = 0; d < maxDepth && frontier.length; d++) {
		const next: string[] = [];
		for (const p of frontier) {
			for (const q of step(p)) {
				if (prev.has(q)) continue;
				prev.set(q, p);
				if (q === to) {
					const chain = [q];
					let cur = p;
					while (cur) {
						chain.unshift(cur);
						cur = prev.get(cur) ?? "";
					}
					return chain;
				}
				next.push(q);
			}
		}
		frontier = next;
	}
	return null;
}

/** Finds chains that lead back to themselves, once each, for relationships that follow chains. */
export function findLoops(view: EdgeView, incoming: (path: string, prop: string) => ReadonlySet<string>, relations: Relation[]): Loop[] {
	const loops: Loop[] = [];
	for (const r of relations) {
		if (!r.chains || r.property === r.inverse) continue;
		const nodes = new Set<string>();
		for (const [src, prop, tgt] of view.entries()) {
			if (prop === r.property || prop === r.inverse) {
				nodes.add(src);
				nodes.add(tgt);
			}
		}
		const state = new Map<string, 1 | 2>();
		const seenLoops = new Set<string>();
		const stack: string[] = [];
		const visit = (p: string): void => {
			state.set(p, 1);
			stack.push(p);
			for (const q of upStep(view, incoming, r, p)) {
				const s = state.get(q);
				if (s === 1) {
					const cycle = stack.slice(stack.indexOf(q));
					const key = [...cycle].sort().join("\u0000");
					if (!seenLoops.has(key)) {
						seenLoops.add(key);
						loops.push({ prop: r.property, path: [...cycle, q] });
					}
				} else if (s === undefined) visit(q);
			}
			stack.pop();
			state.set(p, 2);
		};
		for (const n of [...nodes].sort()) if (!state.has(n)) visit(n);
	}
	return loops;
}

/** A simple EdgeView over a map, for previews and tests. */
export class MapEdges implements EdgeView {
	constructor(private edges: Map<string, Map<string, Set<string>>>) {}
	*entries(): IterableIterator<[string, string, string]> {
		for (const [src, byProp] of this.edges) for (const [prop, ts] of byProp) for (const t of ts) yield [src, prop, t];
	}
	targets(path: string, prop: string): ReadonlySet<string> {
		return this.edges.get(path)?.get(prop) ?? new Set();
	}
}
