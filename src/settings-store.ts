import { normalizeSettings, type HistoryBatch, type RelateSettings } from "./settings";

/** How the store reaches the settings file: Obsidian's `loadData` and `saveData`, or a fake in tests. */
export interface SettingsIo {
	load(): Promise<unknown>;
	save(data: unknown): Promise<void>;
}

/** What changed when a copy of the settings file arrived from another device. */
export interface ExternalChange {
	/** The relationship list differs, so the index and the mirror snapshot need re-reading. */
	relations: boolean;
	/** Search by meaning settings differ, so the meaning index needs restarting. */
	meaning: boolean;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merges two copies of the undo history by batch id. A batch that either copy has undone, or marked as not
 * undoable, stays that way, so a change undone on one device is never offered again on another.
 */
export function mergeHistory(local: HistoryBatch[], other: HistoryBatch[]): HistoryBatch[] {
	const byId = new Map<string, HistoryBatch>();
	for (const b of other) byId.set(b.id, b);
	for (const b of local) {
		const theirs = byId.get(b.id);
		byId.set(b.id, theirs && !theirs.undoable && b.undoable ? theirs : b);
	}
	return [...byId.values()].sort((a, b) => a.time - b.time);
}

/** Holds Relate's settings in memory and keeps them in step with the settings file. */
export class SettingsStore {
	/** The settings in use. The object stays the same for the plugin's lifetime; a reload updates it in place. */
	settings!: RelateSettings;
	/** Plain-language problems found when the file was loaded, empty when it was sound. */
	problems: string[] = [];

	constructor(private io: SettingsIo) {}

	/** Reads the settings file, repairing anything malformed. */
	async load(): Promise<void> {
		const { settings, problems } = normalizeSettings(await this.io.load());
		this.settings = settings;
		this.problems = problems;
	}

	/** Writes the settings in use to the settings file. */
	save(): Promise<void> {
		return this.io.save(this.settings);
	}

	/**
	 * Reads a copy of the settings file that changed outside Obsidian, usually by sync, and takes it as the settings
	 * in use, keeping history from both copies. Returns null, and keeps the settings in use, when the copy has
	 * problems, such as a file still half-synced.
	 */
	async reload(): Promise<ExternalChange | null> {
		const { settings, problems } = normalizeSettings(await this.io.load());
		if (problems.length) return null;
		const before = this.settings;
		const change: ExternalChange = {
			relations: !same(before.relations, settings.relations),
			meaning: !same(before.semantic, settings.semantic),
		};
		settings.history = mergeHistory(before.history, settings.history);
		Object.assign(this.settings, settings);
		return change;
	}
}
