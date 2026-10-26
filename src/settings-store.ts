import { normalizeSettings, type HistoryBatch, type RelateSettings } from "./settings";
import { mergeHistory } from "./history";

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

/** Holds Relate's settings in memory and keeps them in step with the settings file. */
export class SettingsStore {
	/** The settings in use. The object stays the same for the plugin's lifetime; a reload updates it in place. */
	settings!: RelateSettings;
	/** Plain-language problems found when the file was loaded, empty when it was sound. */
	problems: string[] = [];
	/**
	 * Undo history found in the settings file, where versions up to 1.0.1 kept it. It is saved back with the
	 * settings until the caller has moved it into the history file and cleared this list, so none is lost.
	 */
	legacyHistory: HistoryBatch[] = [];

	constructor(private io: SettingsIo) {}

	/** Reads the settings file, repairing anything malformed. */
	async load(): Promise<void> {
		const { settings, problems, history } = normalizeSettings(await this.io.load());
		this.settings = settings;
		this.problems = problems;
		this.legacyHistory = history;
	}

	/** Writes the settings in use to the settings file. */
	save(): Promise<void> {
		return this.io.save(this.legacyHistory.length ? { ...this.settings, history: this.legacyHistory } : this.settings);
	}

	/**
	 * Reads a copy of the settings file that changed outside Obsidian, usually by sync, and takes it as the settings
	 * in use. Undo history in it, from a device on an earlier version, joins `legacyHistory`. Returns null, and
	 * keeps the settings in use, when the copy has problems, such as a file still half-synced.
	 */
	async reload(): Promise<ExternalChange | null> {
		const { settings, problems, history } = normalizeSettings(await this.io.load());
		if (problems.length) return null;
		const before = this.settings;
		const change: ExternalChange = {
			relations: !same(before.relations, settings.relations),
			meaning: !same(before.semantic, settings.semantic),
		};
		this.legacyHistory = mergeHistory(this.legacyHistory, history);
		Object.assign(this.settings, settings);
		return change;
	}
}
