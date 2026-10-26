/** A relationship: two properties that Relate keeps in step on both notes. */
export interface Relation {
	/** Property written on the note that starts the link, e.g. "parent". */
	property: string;
	/** Property written on the other note, e.g. "children". Same as `property` for a two-way pair such as "related". */
	inverse: string;
	/** The note can hold only one link in `property`. */
	propertyOne: boolean;
	/** The note can hold only one link in `inverse`. */
	inverseOne: boolean;
	/** Search can follow chains, e.g. children of children. */
	chains: boolean;
	/**
	 * Notes that need at least one link in `property`: a folder path such as "Research/Notes", or a tag such as
	 * "#paper". Check links lists the ones that have none. Empty or absent means no rule.
	 */
	required?: string;
}

/** One link Relate added to or removed from one note. */
export interface HistoryOp {
	path: string;
	prop: string;
	target: string;
	action: "add" | "remove";
	/** Original value text for removals, e.g. "[[Note|Alias]]", so undo restores it exactly. */
	text?: string;
}

/** One change Relate made to notes, as Recent changes lists it. */
export interface HistoryBatch {
	id: string;
	time: number;
	label: string;
	ops: HistoryOp[];
	undoable: boolean;
	/** How many notes changed, when the batch was too large to keep its changes for undo. */
	count?: number;
}

/** Which date a search phrase such as "last month" looks at. */
export type DateSource = "modified" | "created" | "property";

/** Synced settings for search by meaning. Each device still agrees for itself before anything downloads or leaves it. */
export interface SemanticSettings {
	/** Search by meaning is on. Each device still asks before it downloads the model. */
	enabled: boolean;
	source: "builtin" | "server";
	serverUrl: string;
	serverModel: string;
	/** Name of the key in Obsidian's keychain, when the server needs one. */
	secretId: string;
}

/** Search by meaning settings for a new install. */
export const DEFAULT_SEMANTIC: SemanticSettings = {
	enabled: false,
	source: "builtin",
	serverUrl: "http://localhost:11434",
	serverModel: "nomic-embed-text",
	secretId: "",
};

/** Everything Relate keeps in its settings file. */
export interface RelateSettings {
	relations: Relation[];
	autoSync: boolean;
	mirrorRemovals: boolean;
	dateSource: DateSource;
	dateProperty: string;
	welcomed: boolean;
	/** The user closed the Connections panel themselves, so Relate leaves it closed. */
	panelClosed: boolean;
	/** Recent errors, kept so they can be read from the settings file when a panel fails. */
	errors: { time: number; where: string; message: string }[];
	semantic: SemanticSettings;
	/** After an update, show a notice in the Connections panel that opens the release notes. */
	showReleaseNotes: boolean;
	/** The newest release whose notes the reader has seen; see release-notes.ts. */
	lastShownVersion: string;
}

/** Settings for a new install. */
export const DEFAULT_SETTINGS: RelateSettings = {
	relations: [],
	autoSync: true,
	mirrorRemovals: true,
	dateSource: "modified",
	dateProperty: "",
	welcomed: false,
	panelClosed: false,
	errors: [],
	semantic: DEFAULT_SEMANTIC,
	showReleaseNotes: true,
	lastShownVersion: "",
};

/** One side of a relationship, seen from the note that holds `prop`. */
export interface Side {
	/** Property name on this side. */
	prop: string;
	/** Property name on the other side. */
	inverse: string;
	/** This side holds at most one link. */
	one: boolean;
	/** The other side holds at most one link. */
	inverseOne: boolean;
	chains: boolean;
	relation: Relation;
}

/** Every relationship property mapped to its side. A two-way pair has one entry. */
export function sidesOf(relations: Relation[]): Map<string, Side> {
	const sides = new Map<string, Side>();
	for (const r of relations) {
		const p = r.property.trim();
		const q = r.inverse.trim();
		if (!p || !q) continue;
		if (!sides.has(p)) {
			sides.set(p, { prop: p, inverse: q, one: r.propertyOne, inverseOne: r.inverseOne, chains: r.chains, relation: r });
		}
		if (q !== p && !sides.has(q)) {
			sides.set(q, { prop: q, inverse: p, one: r.inverseOne, inverseOne: r.propertyOne, chains: r.chains, relation: r });
		}
	}
	return sides;
}

/** Plain-language problems with the relationship list, or an empty list when it is valid. */
export function validateRelations(relations: Relation[]): string[] {
	const problems: string[] = [];
	const seen = new Map<string, number>();
	relations.forEach((r, i) => {
		const p = r.property.trim();
		const q = r.inverse.trim();
		if (!p || !q) {
			problems.push(`Relationship ${i + 1} needs a property name on both sides.`);
			return;
		}
		for (const name of new Set([p, q])) {
			if (seen.has(name)) {
				problems.push(`"${name}" is used by more than one relationship. Each property can belong to one relationship only.`);
			}
			seen.set(name, i);
		}
		if (p === q && r.propertyOne !== r.inverseOne) {
			problems.push(`"${p}" links both ways, so its "only one" setting must match on both sides.`);
		}
	});
	return problems;
}

/** A sensible other-side name for a property the user wants to adopt. */
export function suggestInverse(prop: string): { inverse: string; propertyOne: boolean; inverseOne: boolean } {
	const key = prop.trim().toLowerCase();
	const pairs: Record<string, [string, boolean, boolean]> = {
		parent: ["children", true, false],
		parents: ["children", false, false],
		children: ["parent", false, true],
		child: ["parent", false, true],
		up: ["down", false, false],
		down: ["up", false, false],
		next: ["previous", true, true],
		previous: ["next", true, true],
		prev: ["next", true, true],
		project: ["notes", false, false],
		projects: ["notes", false, false],
		collection: ["items", false, false],
		collections: ["items", false, false],
		"part of": ["has part", false, false],
		"has part": ["part of", false, false],
		"belongs to": ["contains", false, false],
		contains: ["belongs to", false, false],
		author: ["works", false, false],
		people: ["mentioned in", false, false],
		source: ["used in", false, false],
		sources: ["used in", false, false],
		about: ["discussed in", false, false],
		home: ["residents", true, false],
		region: ["places", true, false],
		"member of": ["members", false, false],
		members: ["member of", false, false],
		cites: ["cited in", false, false],
		bore: ["bearers", false, false],
	};
	const symmetric = new Set(["related", "see also", "siblings", "sibling", "similar", "peers", "links", "connections", "spouse", "partner", "friends"]);
	if (symmetric.has(key)) return { inverse: prop, propertyOne: false, inverseOne: false };
	const hit = pairs[key];
	if (hit) return { inverse: hit[0], propertyOne: hit[1], inverseOne: hit[2] };
	return { inverse: `${prop} of`, propertyOne: false, inverseOne: false };
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Turns stored undo history into valid batches, leaving out any that are malformed. */
export function normalizeHistory(raw: unknown): HistoryBatch[] {
	const history: HistoryBatch[] = [];
	for (const b of Array.isArray(raw) ? (raw as unknown[]) : []) {
		if (!isObj(b) || !Array.isArray(b.ops) || typeof b.id !== "string") continue;
		const ops = (b.ops as unknown[]).filter(
			(o): o is HistoryOp => isObj(o) && typeof o.path === "string" && typeof o.prop === "string" && typeof o.target === "string" && (o.action === "add" || o.action === "remove")
		);
		history.push({
			id: b.id,
			time: typeof b.time === "number" ? b.time : 0,
			label: typeof b.label === "string" ? b.label : "Change",
			ops,
			undoable: b.undoable === true,
			...(typeof b.count === "number" ? { count: b.count } : {}),
		});
	}
	return history;
}

/**
 * Turns whatever is in the settings file into valid settings. Anything malformed falls back to its default,
 * and each fallback is described in plain language, so a damaged or half-synced file never stops Relate loading.
 * `history` is undo history that versions up to 1.0.1 kept in the settings file; it now lives in its own file.
 */
export function normalizeSettings(raw: unknown): { settings: RelateSettings; problems: string[]; history: HistoryBatch[] } {
	const problems: string[] = [];
	const d = isObj(raw) ? raw : {};
	if (raw !== undefined && raw !== null && !isObj(raw)) problems.push("The settings file was not readable.");
	const bool = (k: keyof RelateSettings, def: boolean): boolean => {
		const v = d[k];
		if (v === undefined) return def;
		if (typeof v === "boolean") return v;
		problems.push(`“${k}” was not on or off.`);
		return def;
	};
	const str = (v: unknown, def: string): string => (typeof v === "string" ? v : def);

	const relations: Relation[] = [];
	if (d.relations !== undefined && !Array.isArray(d.relations)) problems.push("The relationship list was not a list.");
	for (const r of Array.isArray(d.relations) ? d.relations : []) {
		if (!isObj(r) || typeof r.property !== "string" || typeof r.inverse !== "string") {
			problems.push("A relationship without two property names was left out.");
			continue;
		}
		relations.push({
			property: r.property,
			inverse: r.inverse,
			propertyOne: r.propertyOne === true,
			inverseOne: r.inverseOne === true,
			chains: r.chains === true,
			...(typeof r.required === "string" && r.required.trim() ? { required: r.required.trim() } : {}),
		});
	}

	const sem = isObj(d.semantic) ? d.semantic : {};
	const source = sem.source === "server" ? "server" : "builtin";
	const dateSource = d.dateSource === "created" || d.dateSource === "property" ? d.dateSource : "modified";
	const errors = Array.isArray(d.errors)
		? (d.errors as unknown[]).filter((e): e is { time: number; where: string; message: string } => isObj(e) && typeof e.message === "string")
		: [];

	return {
		problems,
		history: normalizeHistory(d.history),
		settings: {
			relations,
			autoSync: bool("autoSync", DEFAULT_SETTINGS.autoSync),
			mirrorRemovals: bool("mirrorRemovals", DEFAULT_SETTINGS.mirrorRemovals),
			dateSource,
			dateProperty: str(d.dateProperty, ""),
			welcomed: d.welcomed === true,
			panelClosed: d.panelClosed === true,
			errors,
			showReleaseNotes: bool("showReleaseNotes", DEFAULT_SETTINGS.showReleaseNotes),
			lastShownVersion: str(d.lastShownVersion, ""),
			semantic: {
				enabled: sem.enabled === true,
				source,
				serverUrl: str(sem.serverUrl, DEFAULT_SEMANTIC.serverUrl),
				serverModel: str(sem.serverModel, DEFAULT_SEMANTIC.serverModel),
				secretId: str(sem.secretId, ""),
			},
		},
	};
}

/** Common setups, offered when a vault has no relationships yet or the user wants to add one quickly. */
export const PRESETS: { name: string; description: string; relation: Relation }[] = [
	{
		name: "Projects and their notes",
		description: "A note lists its project under “project”. The project lists it under “notes”.",
		relation: { property: "project", inverse: "notes", propertyOne: false, inverseOne: false, chains: false },
	},
	{
		name: "Parents and children",
		description: "Each note has one “parent”. The parent lists it under “children”. Search can follow the whole family tree.",
		relation: { property: "parent", inverse: "children", propertyOne: true, inverseOne: false, chains: true },
	},
	{
		name: "Places within places",
		description: "Each place sits in one “region”. The region lists it under “places”, all the way up.",
		relation: { property: "region", inverse: "places", propertyOne: true, inverseOne: false, chains: true },
	},
	{
		name: "People and meetings",
		description: "A meeting lists its “attendees”. Each person lists the meeting under “meetings”.",
		relation: { property: "attendees", inverse: "meetings", propertyOne: false, inverseOne: false, chains: false },
	},
	{
		name: "Sources and citations",
		description: "A note lists what it “cites”. Each source lists the note under “cited in”.",
		relation: { property: "cites", inverse: "cited in", propertyOne: false, inverseOne: false, chains: false },
	},
	{
		name: "Related notes",
		description: "Both notes list each other under “related”.",
		relation: { property: "related", inverse: "related", propertyOne: false, inverseOne: false, chains: false },
	},
	{
		name: "A sequence",
		description: "Each note has one “next” and one “previous”, for chapters, steps or a reading order.",
		relation: { property: "next", inverse: "previous", propertyOne: true, inverseOne: true, chains: false },
	},
];

/** Presets whose property names are all free in the current setup. */
export function availablePresets(relations: Relation[]) {
	const used = new Set(relations.flatMap((r) => [r.property, r.inverse]));
	return PRESETS.filter((p) => !used.has(p.relation.property) && !used.has(p.relation.inverse));
}
