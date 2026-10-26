import { normalizeHistory, type HistoryBatch, type HistoryOp } from "./settings";
import type { UndoOutcome } from "./sync";

/** Most batches Recent changes keeps. */
const MAX_BATCHES = 30;
/** Largest history file, in characters of JSON. Older batches drop out first. */
export const MAX_HISTORY_SIZE = 2_000_000;
/** Largest batch whose changes are kept for undo, in characters of JSON: roughly 8,000 changed links. */
export const MAX_BATCH_SIZE = 1_000_000;
/** How long the history waits after a change before writing its file, so a burst of changes writes once. */
const SAVE_DELAY_MS = 500;

/** Files in the plugin's own folder, reached through Obsidian's vault adapter or a fake in tests. */
export interface PluginFiles {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

/** What the history needs: its file, how to reverse changes, and how to tell the user. */
export interface HistoryHost {
	files: PluginFiles;
	/** The history file, normalized, in the plugin folder. */
	path: string;
	/** Reverses recorded changes in the vault. */
	reverse(label: string, ops: HistoryOp[]): Promise<UndoOutcome>;
	/** Shows a message to the user. */
	notify(message: string, ms?: number): void;
	/** Records an error that the user does not need to act on. */
	reportError(where: string, e: unknown): void;
}

/** Identifies one change, so a change read back from disk still matches the one recorded. */
function key(op: HistoryOp): string {
	return `${op.action}\u0000${op.path}\u0000${op.prop}\u0000${op.target}`;
}

/**
 * Merges two copies of the history by batch id. A batch that either copy has undone, or marked as not undoable,
 * stays that way, so a change undone on one device is never offered again on another.
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

/** The newest batches that fit the limits on count and size, oldest first. */
function cap(batches: HistoryBatch[]): HistoryBatch[] {
	const kept: HistoryBatch[] = [];
	let size = 0;
	for (const b of [...batches].reverse()) {
		size += JSON.stringify(b).length;
		if (kept.length >= MAX_BATCHES || size > MAX_HISTORY_SIZE) break;
		kept.push(b);
	}
	return kept.reverse();
}

/**
 * Recent changes Relate made to notes, and their undo. The history lives in its own file in the plugin folder,
 * apart from the settings, so a large batch never slows down saving the settings. Each save merges with the copy
 * on disk, so batches that sync brings from another device are kept.
 */
export class History {
	private batches: HistoryBatch[] = [];
	private saveTimer: number | null = null;
	private saving: Promise<void> = Promise.resolve();

	constructor(private host: HistoryHost) {}

	/** The recorded batches, oldest first. */
	list(): readonly HistoryBatch[] {
		return this.batches;
	}

	/**
	 * Reads the history file and folds in `legacy`, history that an earlier version kept in the settings file.
	 * Resolves to true once `legacy` is safely in the history file, so the caller can drop it from the settings.
	 */
	async load(legacy: HistoryBatch[] = []): Promise<boolean> {
		const disk = await this.readFile();
		this.batches = cap(mergeHistory(mergeHistory(this.batches, disk), legacy));
		if (!legacy.length) return true;
		try {
			await this.host.files.write(this.host.path, JSON.stringify(this.batches));
			return true;
		} catch (e) {
			this.host.reportError("Moving undo history to its own file", e);
			return false;
		}
	}

	/** Reads the history file again, after sync may have changed it. */
	async reload(): Promise<void> {
		const disk = await this.readFile();
		this.batches = cap(mergeHistory(this.batches, disk));
	}

	private async readFile(): Promise<HistoryBatch[]> {
		try {
			if (!(await this.host.files.exists(this.host.path))) return [];
			return normalizeHistory(JSON.parse(await this.host.files.read(this.host.path)));
		} catch (e) {
			this.host.reportError("Reading undo history", e);
			return [];
		}
	}

	/**
	 * Records a batch of changes and returns its id. A batch too large to keep for undo is recorded without its
	 * changes, and the user is told that it cannot be undone.
	 */
	record(label: string, ops: HistoryOp[], undoable: boolean): string {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const batch: HistoryBatch = { id, time: Date.now(), label, ops: [...ops], undoable };
		if (JSON.stringify(batch).length > MAX_BATCH_SIZE) {
			batch.ops = [];
			batch.count = ops.length;
			if (undoable) {
				batch.undoable = false;
				this.host.notify(`Relate made ${ops.length} changes in “${label}”. That is too many to keep for undo, so this change cannot be undone.`, 12000);
			}
		}
		this.batches = cap([...this.batches, batch]);
		this.scheduleSave();
		return id;
	}

	/** The newest batch that can still be undone. */
	latest(): HistoryBatch | undefined {
		return [...this.batches].reverse().find((b) => b.undoable);
	}

	/**
	 * Undoes a recorded batch, or only `part` of it. Each change that was reversed leaves the batch; the batch is
	 * marked undone once none is left. Anything that could not be reversed stays, so the user can try again, and
	 * the notice says why.
	 */
	async undo(id: string, part?: HistoryOp[]): Promise<void> {
		const batch = this.batches.find((b) => b.id === id);
		if (!batch || !batch.undoable) return;
		const label = batch.label.replace(/ \((partly )?undone\)$/, "");
		const wanted = new Set((part ?? batch.ops).map(key));
		const ops = batch.ops.filter((op) => wanted.has(key(op)));
		const result = await this.host.reverse(label, ops);
		const left = new Set(result.unresolved.map(key));
		const reversed = new Set(ops.map(key).filter((k) => !left.has(k)));
		batch.ops = batch.ops.filter((op) => !reversed.has(key(op)));
		if (!batch.ops.length) {
			batch.undoable = false;
			batch.label = `${label} (undone)`;
		} else if (reversed.size) {
			batch.label = `${label} (partly undone)`;
		}
		if (!result.unresolved.length) {
			this.host.notify(`Relate undid “${label}”.`);
		} else {
			const n = result.unresolved.length;
			this.host.notify(
				`Relate undid ${result.done} of ${result.done + n} changes in “${label}”. ${n === 1 ? "One change" : `${n} changes`} could not be undone: ${[...new Set(result.reasons)].join(" ")} ${n === 1 ? "It stays" : "They stay"} under Recent changes, so you can try again.`,
				12000
			);
		}
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MS);
	}

	/** Writes the history file now, merged with the copy on disk. Saves run one at a time. */
	flush(): Promise<void> {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.saving = this.saving.then(async () => {
			try {
				const disk = await this.readFile();
				this.batches = cap(mergeHistory(this.batches, disk));
				await this.host.files.write(this.host.path, JSON.stringify(this.batches));
			} catch (e) {
				this.host.reportError("Saving undo history", e);
			}
		});
		return this.saving;
	}
}
