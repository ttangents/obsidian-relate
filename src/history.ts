import type { HistoryBatch, HistoryOp } from "./settings";
import type { UndoOutcome } from "./sync";

const MAX_HISTORY = 30;
const MAX_OPS_PER_BATCH = 5000;

/** What the history needs: where its batches live, how to reverse changes, and how to tell the user. */
export interface HistoryHost {
	/** The recorded batches, oldest first. */
	batches(): HistoryBatch[];
	/** Stores the batches after a change. */
	save(): void;
	/** Reverses recorded changes in the vault. */
	reverse(label: string, ops: HistoryOp[]): Promise<UndoOutcome>;
	/** Shows a message to the user. */
	notify(message: string, ms?: number): void;
}

/** Identifies one change, so a change read back from disk still matches the one recorded. */
function key(op: HistoryOp): string {
	return `${op.action}\u0000${op.path}\u0000${op.prop}\u0000${op.target}`;
}

/** Recent changes Relate made to notes, and their undo. */
export class History {
	constructor(private host: HistoryHost) {}

	/** Records a batch of changes and returns its id. */
	record(label: string, ops: HistoryOp[], undoable: boolean): string {
		const batches = this.host.batches();
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		batches.push({
			id,
			time: Date.now(),
			label,
			ops: ops.slice(0, MAX_OPS_PER_BATCH),
			undoable: undoable && ops.length <= MAX_OPS_PER_BATCH,
		});
		if (batches.length > MAX_HISTORY) batches.splice(0, batches.length - MAX_HISTORY);
		this.host.save();
		return id;
	}

	/** The newest batch that can still be undone. */
	latest(): HistoryBatch | undefined {
		return [...this.host.batches()].reverse().find((b) => b.undoable);
	}

	/**
	 * Undoes a recorded batch, or only `part` of it. Each change that was reversed leaves the batch; the batch is
	 * marked undone once none is left. Anything that could not be reversed stays, so the user can try again, and
	 * the notice says why.
	 */
	async undo(id: string, part?: HistoryOp[]): Promise<void> {
		const batch = this.host.batches().find((b) => b.id === id);
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
		this.host.save();
	}
}
