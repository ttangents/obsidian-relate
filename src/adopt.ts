import { getLinkpath, type App } from "obsidian";
import { readEdges, type Edges } from "./graph";
import { computeHealth, MapEdges } from "./health";
import { sidesOf, suggestInverse, type Relation } from "./settings";

/** A property that already links notes, with a suggested relationship for it. */
export interface PropertyUse {
	prop: string;
	/** Notes that use the property for a link. */
	notes: number;
	/** Links the property holds across the vault. */
	links: number;
	relation: Relation;
}

/** The properties worth offering, and how many were left out. */
export interface PropertyScan {
	candidates: PropertyUse[];
	/** Properties used in only one note. */
	hiddenRare: number;
	/** Properties beyond the first `max`. */
	hiddenMore: number;
}

/**
 * Properties whose values link to other notes, most used first, leaving out those in `taken`. Links to images,
 * PDFs and other files do not count, and a property used in only one note does not look like a relationship.
 */
export function scanProperties(app: App, taken: Set<string>, max = 15): PropertyScan {
	const stats = new Map<string, { notes: Set<string>; links: number }>();
	for (const f of app.vault.getMarkdownFiles()) {
		const links = app.metadataCache.getFileCache(f)?.frontmatterLinks;
		if (!links) continue;
		for (const l of links) {
			const prop = l.key.replace(/\.\d+$/, "");
			if (taken.has(prop)) continue;
			const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), f.path);
			if (!dest || dest.extension !== "md") continue;
			const s = stats.get(prop) ?? { notes: new Set<string>(), links: 0 };
			s.notes.add(f.path);
			s.links++;
			stats.set(prop, s);
		}
	}
	const all = [...stats.entries()];
	const used = all.filter(([, s]) => s.notes.size >= 2).sort((a, b) => b[1].links - a[1].links);
	return {
		hiddenRare: all.length - used.length,
		hiddenMore: Math.max(0, used.length - max),
		candidates: used.slice(0, max).map(([prop, s]) => {
			const g = suggestInverse(prop);
			return {
				prop,
				notes: s.notes.size,
				links: s.links,
				relation: { property: prop, inverse: g.inverse, propertyOne: g.propertyOne, inverseOne: g.inverseOne, chains: false },
			};
		}),
	};
}

/** What adopting `relations` would do, found with the same check Check links uses, without writing anything. */
export function previewRelations(app: App, relations: Relation[]): { links: number; notes: number; choices: number } {
	const props = new Set<string>();
	for (const r of relations) {
		props.add(r.property);
		props.add(r.inverse);
	}
	const edges = new Map<string, Edges>();
	for (const f of app.vault.getMarkdownFiles()) {
		const e = readEdges(app, f, props);
		if (e.size) edges.set(f.path, e);
	}
	const { missing, conflicts } = computeHealth(new MapEdges(edges), sidesOf(relations));
	return { links: missing.length, notes: new Set(missing.map((m) => m.file)).size, choices: conflicts.length };
}
