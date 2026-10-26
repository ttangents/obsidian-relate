import { normalizeSettings, type HistoryBatch, type RelateSettings } from "./settings";
import { mergeHistory, type PluginFiles } from "./history";

/** How the store reaches the settings file: Obsidian's `loadData` and `saveData`, or a fake in tests. */
export interface SettingsIo {
	load(): Promise<unknown>;
	save(data: unknown): Promise<void>;
	/** The plugin folder, for reading the settings file as text and writing its backup. */
	files: PluginFiles;
	/** The settings file, normalized. */
	dataPath: string;
	/** Where a damaged settings file is copied before Relate first saves over it. */
	backupPath: string;
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
	/** The damaged file's text, still to be copied to the backup before the first save. */
	private pendingBackup: string | null = null;

	constructor(private io: SettingsIo) {}

	/**
	 * Reads the settings file, repairing anything malformed. When the file had problems, its original text is kept
	 * aside and written to the backup before the first save, and a vault that had settings is never treated as new.
	 */
	async load(): Promise<void> {
		const raw = await this.io.load();
		const { settings, problems, history } = normalizeSettings(raw);
		// Obsidian's loadData returns null both for a missing file and for one it could not parse.
		const text = await this.readText();
		if ((raw === null || raw === undefined) && text?.trim()) {
			try {
				JSON.parse(text);
			} catch {
				problems.push("The settings file was not readable.");
			}
		}
		if (problems.length && text !== null) this.pendingBackup = text;
		if ((problems.length && text !== null) || (await this.io.files.exists(this.io.backupPath))) settings.welcomed = true;
		this.settings = settings;
		this.problems = problems;
		this.legacyHistory = history;
	}

	private async readText(): Promise<string | null> {
		try {
			return (await this.io.files.exists(this.io.dataPath)) ? await this.io.files.read(this.io.dataPath) : null;
		} catch {
			return null;
		}
	}

	/** Writes the settings in use to the settings file, after backing up a damaged original. */
	async save(): Promise<void> {
		if (this.pendingBackup !== null) {
			// If the backup cannot be written, this throws and the damaged original stays untouched.
			await this.io.files.write(this.io.backupPath, this.pendingBackup);
			this.pendingBackup = null;
		}
		await this.io.save(this.legacyHistory.length ? { ...this.settings, history: this.legacyHistory } : this.settings);
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
