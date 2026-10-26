import { App, TFile, getLinkpath } from "obsidian";
import { keyBelongsTo } from "./links";

export type Edges = Map<string, Set<string>>;

export interface Diff {
	added: [string, string][];
	removed: [string, string][];
}

/** Reads relationship links from one note's properties: property name -> target note paths. */
export function readEdges(app: App, file: TFile, props: Iterable<string>): Edges {
	const edges: Edges = new Map();
	const links = app.metadataCache.getFileCache(file)?.frontmatterLinks;
	if (!links?.length) return edges;
	const wanted = [...props];
	for (const l of links) {
		const prop = wanted.find((p) => keyBelongsTo(l.key, p));
		if (!prop) continue;
		const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), file.path);
		if (!dest || dest.extension !== "md") continue;
		let set = edges.get(prop);
		if (!set) edges.set(prop, (set = new Set()));
		set.add(dest.path);
	}
	return edges;
}

/** Every relationship link in the vault, kept current from Obsidian's metadata cache. Lives in memory only. */
export class EdgeIndex {
	/** Goes up whenever the links change, so callers can cache work done on them. */
	revision = 0;
	private out = new Map<string, Edges>();
	private incomingCache: Map<string, Map<string, Set<string>>> | null = null;

	constructor(private app: App, private props: () => Set<string>) {}

	rebuild(): void {
		this.out.clear();
		const props = this.props();
		if (props.size) {
			for (const f of this.app.vault.getMarkdownFiles()) {
				const e = readEdges(this.app, f, props);
				if (e.size) this.out.set(f.path, e);
			}
		}
		this.incomingCache = null;
		this.revision++;
	}

	/** Re-reads one note and reports which links appeared or disappeared since the last read. */
	update(file: TFile): Diff {
		const before = this.out.get(file.path) ?? new Map<string, Set<string>>();
		const after = readEdges(this.app, file, this.props());
		const diff: Diff = { added: [], removed: [] };
		for (const [prop, targets] of after) {
			const old = before.get(prop);
			for (const t of targets) if (!old?.has(t)) diff.added.push([prop, t]);
		}
		for (const [prop, targets] of before) {
			const now = after.get(prop);
			for (const t of targets) if (!now?.has(t)) diff.removed.push([prop, t]);
		}
		if (after.size) this.out.set(file.path, after);
		else this.out.delete(file.path);
		if (diff.added.length || diff.removed.length) {
			this.incomingCache = null;
			this.revision++;
		}
		return diff;
	}

	rename(oldPath: string, newPath: string): void {
		const own = this.out.get(oldPath);
		if (own) {
			this.out.delete(oldPath);
			this.out.set(newPath, own);
		}
		// Links in other notes are re-read from their own change events. If Obsidian updated them, they
		// point to the new path; if link updating is off, they no longer resolve. Either way the index follows the files.
		this.incomingCache = null;
		this.revision++;
	}

	delete(path: string): void {
		this.out.delete(path);
		this.incomingCache = null;
		this.revision++;
	}

	/** Notes that `path` lists under `prop`. Read-only: the set belongs to the index. */
	targets(path: string, prop: string): ReadonlySet<string> {
		return this.out.get(path)?.get(prop) ?? new Set();
	}

	/** Notes whose `prop` points at `path`. Read-only: the set belongs to the index. */
	incoming(path: string, prop: string): ReadonlySet<string> {
		if (!this.incomingCache) {
			const cache = new Map<string, Map<string, Set<string>>>();
			for (const [src, edges] of this.out) {
				for (const [p, targets] of edges) {
					for (const t of targets) {
						let byProp = cache.get(t);
						if (!byProp) cache.set(t, (byProp = new Map<string, Set<string>>()));
						let set = byProp.get(p);
						if (!set) byProp.set(p, (set = new Set()));
						set.add(src);
					}
				}
			}
			this.incomingCache = cache;
		}
		return this.incomingCache.get(path)?.get(prop) ?? new Set();
	}

	/** Has any relationship in either direction. */
	hasEdges(path: string): boolean {
		if (this.out.has(path)) return true;
		this.incoming(path, "");
		return !!this.incomingCache?.has(path);
	}

	*entries(): IterableIterator<[string, string, string]> {
		for (const [src, edges] of this.out) {
			for (const [prop, targets] of edges) for (const t of targets) yield [src, prop, t];
		}
	}
}

/**
 * Notes reachable from `start` by repeating `step`. With `follow` off, takes one step only.
 * Stops at `maxDepth` levels and says whether it had to.
 */
export function traverse(start: string, step: (p: string) => Set<string>, follow: boolean, maxDepth: number): { paths: Set<string>; truncated: boolean } {
	if (!follow) {
		const one = new Set(step(start));
		one.delete(start);
		return { paths: one, truncated: false };
	}
	const seen = new Set<string>([start]);
	let frontier = [start];
	for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
		const next: string[] = [];
		for (const p of frontier) {
			for (const q of step(p)) {
				if (seen.has(q)) continue;
				seen.add(q);
				next.push(q);
			}
		}
		frontier = next;
	}
	seen.delete(start);
	return { paths: seen, truncated: frontier.length > 0 };
}
