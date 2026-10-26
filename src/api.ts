import type { TFile } from "obsidian";
import { BUSY_NOTE, findPaths, type PathGraph, type Step } from "./paths";
import type { RelationQueries } from "./queries";
import type { Relation, Side } from "./settings";
import type { Outcome } from "./sync";

/**
 * The contract other plugins use. Read it from the `relate:ready` workspace event, never from Relate's plugin
 * instance. `version` changes only when a change would break a caller; new members can appear within a version.
 */
export interface RelateApi {
	readonly version: 1;
	/** Notes related to `path` through `prop`, in either direction. Set `all` to follow chains. */
	related(path: string, prop: string, all?: boolean): string[];
	/** Runs a search query exactly as the search box does and returns note paths with reasons. */
	search(query: string): Promise<{ path: string; reasons: string[]; paths: Step[][] }[]>;
	/** Every relationship of the note at `path`, named from its side, whichever note records the link. */
	connections(path: string): { prop: string; path: string }[];
	/** True when search by meaning is on and ready on this device, so `similar` can return notes. */
	meaningReady(): boolean;
	/** Relationship property pairs as configured. */
	relationships(): { property: string; inverse: string }[];
	/** Notes closest in meaning to the note at `path`, best first. Empty when search by meaning is off. */
	similar(path: string, limit?: number): { path: string; score: number }[];
	/**
	 * Short chains of relationships from one note to another, shortest first. Each step is
	 * `{ from, prop, to }`, with `prop` named from the `from` note's side.
	 */
	paths(from: string, to: string, opts?: { property?: string; maxSteps?: number; limit?: number; skipBusy?: boolean }): Step[][];
	/** Links two notes on both sides, as the Connections panel does. Resolves to false, with a reason, when nothing changed. */
	connect(from: string, property: string, to: string): Promise<{ ok: boolean; reason?: string }>;
	/** Removes a link from both notes. */
	disconnect(from: string, property: string, to: string): Promise<{ ok: boolean; reason?: string }>;
}

/** Relate sends this with the API, once it is usable and again on every request. */
export const EVENT_READY = "relate:ready";
/** Another plugin sends this to ask Relate to send `relate:ready` again. */
export const EVENT_REQUEST = "relate:request";
/** Relate sends this when links or the meaning index change. */
export const EVENT_CHANGED = "relate:changed";
/** Relate sends this first thing when it unloads; the API is inert from then on. */
export const EVENT_UNLOAD = "relate:unload";

/**
 * Sends `relate:changed` once a burst of changes settles, and only when the links or the meaning index really
 * changed, so a listener that clears a cache does so once per change.
 */
export class ChangeSignal {
	private timer: number | null = null;
	private last = "";
	private stopped = false;

	/** `state` describes what listeners can see, such as the two indexes' revisions. */
	constructor(private send: () => void, private state: () => string, private delay = 150) {}

	/** Notes that something may have changed. */
	poke(): void {
		if (this.stopped) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const now = this.state();
			if (now === this.last) return;
			this.last = now;
			this.send();
		}, this.delay);
	}

	/** Stops sending, for unload. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}

/** What the API reads and changes. The composition root supplies each part. */
export interface ApiDeps {
	index: PathGraph;
	sides(): Map<string, Side>;
	relations(): Relation[];
	queries: Pick<RelationQueries, "related" | "connections">;
	/** Runs a search query without snippets. */
	search(query: string): Promise<{ file: TFile; reasons: string[]; paths: Step[][] }[]>;
	semantic: { readonly ready: boolean; similar(path: string, limit: number): { path: string; score: number }[] };
	/** The note at `path`, or null when it is missing or not a note. */
	note(path: string): TFile | null;
	connect(file: TFile, side: Side, target: TFile): Promise<Outcome>;
	disconnect(file: TFile, side: Side, targetPath: string): Promise<Outcome>;
	/** Called after the API changed links, so panels redraw. */
	changed(): void;
}

function clamp(n: number | undefined, fallback: number, max: number): number {
	return Math.max(1, Math.min(max, Math.floor(n ?? fallback) || fallback));
}

/** Builds the frozen API object every plugin receives. */
export function createApi(d: ApiDeps): RelateApi {
	const change = async (from: string, property: string, to: string, add: boolean): Promise<{ ok: boolean; reason?: string }> => {
		const side = d.sides().get(property);
		if (!side) return { ok: false, reason: `${property} is not a relationship Relate manages.` };
		const a = d.note(from);
		if (!a) return { ok: false, reason: `${from} is not a note.` };
		if (a.path === to) return { ok: false, reason: "A note cannot be linked to itself." };
		let out: Outcome;
		if (add) {
			const b = d.note(to);
			if (!b) return { ok: false, reason: `${to} is not a note.` };
			out = await d.connect(a, side, b);
		} else {
			out = await d.disconnect(a, side, to);
		}
		if (out.error) return { ok: false, reason: out.error };
		if (!out.applied.length) return { ok: false, reason: out.skipped[0] ?? "Nothing changed." };
		d.changed();
		return { ok: true };
	};
	const api: RelateApi = {
		version: 1,
		related: (path, prop, all = false) => [...d.queries.related(path, prop, all)],
		search: async (q) =>
			(await d.search(String(q))).map((r) => ({
				path: r.file.path,
				reasons: [...r.reasons],
				paths: r.paths.map((p) => p.map((s) => ({ ...s }))),
			})),
		connections: (path) => d.queries.connections(path).map((s) => ({ prop: s.prop, path: s.to })),
		meaningReady: () => d.semantic.ready,
		relationships: () => d.relations().map((r) => ({ property: r.property, inverse: r.inverse })),
		similar: (path, limit) => d.semantic.similar(path, clamp(limit, 5, 50)),
		paths: (from, to, opts = {}) => {
			const sides = d.sides();
			const side = opts.property ? sides.get(opts.property) : undefined;
			if (opts.property && !side) return [];
			return findPaths(d.index, sides, from, to, {
				props: side ? new Set([side.prop, side.inverse]) : undefined,
				maxSteps: clamp(opts.maxSteps, 6, 10),
				limit: clamp(opts.limit, 5, 20),
				busy: opts.skipBusy ? BUSY_NOTE : null,
			});
		},
		connect: (from, property, to) => change(from, property, to, true),
		disconnect: (from, property, to) => change(from, property, to, false),
	};
	// Every plugin gets the same object, so none can change it for the others.
	return Object.freeze(api);
}
