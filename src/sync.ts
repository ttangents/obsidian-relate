import { Notice, TFile } from "obsidian";
import type RelatePlugin from "./main";

/** What the sync engine needs from the plugin, and nothing more. */
export type SyncHost = Pick<
	RelatePlugin,
	"app" | "index" | "record" | "refreshViews" | "registerEvent" | "relationsValid" | "reportError" | "settings" | "sides" | "writer"
>;
import { readEdges, type Edges } from "./graph";
import type { HistoryOp, Side } from "./settings";
import type { AddOptions, AddResult } from "./writer";
import { computeHealth, findLoops, pathUp, upStep, type Conflict, type Health, type Missing } from "./health";

export type { Conflict, Health, Loop, Missing } from "./health";

export const TIMING = {
	/** Wait this long after a note's last change before mirroring, so half-typed links are never mirrored. */
	settle: 2000,
	/** How long to wait for Obsidian to re-read a note Relate just wrote before trusting its cache anyway. */
	inflight: 5000,
	/** Delays before retrying a mirror that failed. */
	retries: [5000, 20000, 60000],
	/** Longest wait for Obsidian's first full read of the vault. */
	startup: 60000,
};

/** What a batch of writes did. Every applied change is in `applied`, even when the batch stopped partway. */
export interface Outcome {
	applied: HistoryOp[];
	/** Plain-language reasons for proposals Relate did not apply. */
	skipped: string[];
	/** Set when the batch stopped early. */
	error: string | null;
}

export interface UndoOutcome {
	done: number;
	/** Changes that could not be reversed, kept so the user can try again. */
	unresolved: HistoryOp[];
	reasons: string[];
}

class Cancelled extends Error {
	constructor() {
		super("Relate stopped before finishing.");
	}
}

/** Collects each write the moment it happens, so a batch that fails partway still has a full record. */
class Journal {
	ops: HistoryOp[] = [];
	skipped: string[] = [];
}

function name(path: string): string {
	return path.replace(/^.*\//, "").replace(/\.md$/, "");
}

/**
 * Every change Relate makes to notes goes through here: automatic mirroring, explicit linking and unlinking,
 * repairs, conflict choices and undo. Writes run one at a time, are journaled as they happen, and recheck the
 * vault before acting.
 *
 * For each note, Relate keeps a snapshot of the links it has already handled. A note's change is mirrored by
 * comparing its links with that snapshot. When Relate writes a note itself, it updates that note's snapshot
 * with exactly what it wrote, so its own write is never mistaken for an edit, while anything else the user
 * changed in the same note still shows up as a difference.
 */
export class SyncEngine {
	private paused = 0;
	private ready = false;
	private stopped = false;
	private queue: Promise<unknown> = Promise.resolve();
	private timers = new Map<string, number>();
	private attempts = new Map<string, number>();
	private snapshot = new Map<string, Edges>();
	/** Notes Relate wrote whose change Obsidian has not reported yet. Their cache is stale until it does. */
	private inflight = new Map<string, { count: number; since: number }>();
	private startTimer: number | null = null;
	private healthCache: { key: string; value: Health } | null = null;

	constructor(private plugin: SyncHost) {}

	get busy(): boolean {
		return this.paused > 0 || !this.ready;
	}

	pause(): void {
		this.paused++;
	}

	resume(): void {
		this.paused = Math.max(0, this.paused - 1);
	}

	/** Re-reads the vault into the index and the snapshot. Writes nothing. Used at startup and when relationships change. */
	resnapshot(): void {
		this.plugin.index.rebuild();
		this.snapshot.clear();
		const props = this.props();
		for (const f of this.plugin.app.vault.getMarkdownFiles()) {
			const e = readEdges(this.plugin.app, f, props);
			if (e.size) this.snapshot.set(f.path, e);
		}
		this.healthCache = null;
		this.plugin.refreshViews();
	}

	private props(): Set<string> {
		return new Set(this.plugin.sides().keys());
	}

	/**
	 * Waits until Obsidian has read every note once, then takes the first snapshot. Until then a change event may
	 * only mean Obsidian is still reading the vault, so Relate holds mirroring. Edits made meanwhile wait in their
	 * timers and are compared against the first snapshot, so a typical startup holds edits for a moment at most.
	 */
	start(): void {
		const app = this.plugin.app;
		const begun = Date.now();
		const warm = () => app.vault.getMarkdownFiles().every((f) => app.metadataCache.getFileCache(f) !== null);
		const release = () => {
			if (this.ready || this.stopped) return;
			if (this.startTimer !== null) window.clearTimeout(this.startTimer);
			this.startTimer = null;
			this.resnapshot();
			this.ready = true;
		};
		const ref = app.metadataCache.on("resolved", () => {
			app.metadataCache.offref(ref);
			release();
		});
		this.plugin.registerEvent(ref);
		const poll = () => {
			this.startTimer = null;
			if (this.ready || this.stopped) return;
			if (warm() || Date.now() - begun > TIMING.startup) release();
			else this.startTimer = window.setTimeout(poll, 250);
		};
		poll();
	}

	/** Stops all work. Queued jobs and writes still in a batch are cancelled before they touch another note. */
	stop(): void {
		this.stopped = true;
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
		if (this.startTimer !== null) window.clearTimeout(this.startTimer);
		this.startTimer = null;
	}

	private file(path: string): TFile | null {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile && f.extension === "md" ? f : null;
	}

	/** True when Obsidian could not parse the note's properties, e.g. while YAML is half-typed. */
	private unparsed(file: TFile): boolean {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		return !!cache?.frontmatterPosition && !cache.frontmatter;
	}

	private schedule(path: string, delay: number): void {
		if (this.stopped) return;
		const old = this.timers.get(path);
		if (old !== undefined) window.clearTimeout(old);
		this.timers.set(
			path,
			window.setTimeout(() => {
				this.timers.delete(path);
				const f = this.file(path);
				if (f) void this.enqueue(() => this.mirror(f));
			}, delay)
		);
	}

	/** Called for every metadata change. */
	onChanged(file: TFile): void {
		if (this.stopped || file.extension !== "md") return;
		const pending = this.inflight.get(file.path);
		if (pending && --pending.count <= 0) this.inflight.delete(file.path);
		if (this.unparsed(file)) return;
		const diff = this.plugin.index.update(file);
		if (diff.added.length || diff.removed.length) {
			this.healthCache = null;
			this.plugin.refreshViews();
		}
		this.schedule(file.path, TIMING.settle);
	}

	onRename(oldPath: string, newPath: string): void {
		const own = this.snapshot.get(oldPath);
		if (own) {
			this.snapshot.delete(oldPath);
			this.snapshot.set(newPath, own);
		}
		const t = this.timers.get(oldPath);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.delete(oldPath);
		this.healthCache = null;
	}

	onDelete(path: string): void {
		this.snapshot.delete(path);
		this.inflight.delete(path);
		const t = this.timers.get(path);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.delete(path);
		this.healthCache = null;
	}

	/** Runs jobs one at a time. A failed job never blocks the jobs after it. */
	enqueue<T>(job: () => Promise<T>): Promise<T | undefined> {
		const run = this.queue.then(async () => (this.stopped ? undefined : job()));
		this.queue = run.catch((e) => {
			if (!(e instanceof Cancelled)) this.plugin.reportError("Updating linked notes", e);
		});
		return run.catch(() => undefined);
	}

	// ----------------------------------------------------------------- writes

	private check(): void {
		if (this.stopped) throw new Cancelled();
	}

	private snap(path: string, prop: string, target: string, add: boolean): void {
		let edges = this.snapshot.get(path);
		if (!edges) this.snapshot.set(path, (edges = new Map<string, Set<string>>()));
		let set = edges.get(prop);
		if (!set) edges.set(prop, (set = new Set()));
		if (add) set.add(target);
		else set.delete(target);
	}

	private wrote(path: string): void {
		const p = this.inflight.get(path);
		if (p) p.count++;
		else this.inflight.set(path, { count: 1, since: Date.now() });
	}

	/** Adds one link, journals it, and records it in the note's snapshot as Relate's own change. */
	private async addOne(j: Journal, file: TFile, prop: string, target: TFile, one: boolean, opts: AddOptions = {}): Promise<AddResult> {
		this.check();
		const r = await this.plugin.writer.addLink(file, prop, target, one, opts);
		if (!r.changed) return r;
		this.wrote(file.path);
		if (r.replaced) {
			j.ops.push({ path: file.path, prop, target: r.replaced, action: "remove", text: r.replacedText ?? undefined });
			this.snap(file.path, prop, r.replaced, false);
		}
		j.ops.push({ path: file.path, prop, target: target.path, action: "add", text: opts.text });
		this.snap(file.path, prop, target.path, true);
		return r;
	}

	private async removeOne(j: Journal, file: TFile, prop: string, targetPath: string): Promise<boolean> {
		this.check();
		const text = await this.plugin.writer.removeLink(file, prop, targetPath);
		if (text === null) return false;
		this.wrote(file.path);
		j.ops.push({ path: file.path, prop, target: targetPath, action: "remove", text });
		this.snap(file.path, prop, targetPath, false);
		return true;
	}

	/** Runs a batch in the queue. Whatever it applied is recorded, even if it stops partway. */
	private async batch(label: string, undoable: boolean, work: (j: Journal) => Promise<void>): Promise<Outcome> {
		const j = new Journal();
		let error: string | null = null;
		await this.enqueue(async () => {
			try {
				await work(j);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				if (!(e instanceof Cancelled)) this.plugin.reportError(label, e);
			}
		});
		if (this.stopped && !error && !j.ops.length) error = "Relate stopped before finishing.";
		if (j.ops.length) this.plugin.record(error ? `${label} (stopped partway)` : label, j.ops, undoable);
		if (j.ops.length || error) {
			this.healthCache = null;
			this.plugin.refreshViews();
		}
		return { applied: j.ops, skipped: j.skipped, error };
	}

	/** Makes `target` list `source` back. Moves it from another note when the other side holds only one link. */
	private async addBack(j: Journal, source: TFile, side: Side, target: TFile, notices: string[]): Promise<void> {
		const r = await this.addOne(j, target, side.inverse, source, side.inverseOne);
		if (r.blocked) {
			notices.push(`Relate did not change ${target.basename}, because it already lists more than one ${side.inverse}. Run Check links to choose one.`);
			return;
		}
		if (r.replaced && r.replaced !== source.path) {
			const old = this.file(r.replaced);
			if (old) {
				await this.removeOne(j, old, side.prop, target.path);
				notices.push(`Moved ${target.basename} from ${old.basename} to ${source.basename}.`);
			}
		}
	}

	// ----------------------------------------------------------------- mirroring

	/** Mirrors the difference between a note's links now and the links Relate has already handled. */
	async mirror(file: TFile): Promise<void> {
		if (this.stopped || !this.file(file.path)) return;
		if (!this.ready || this.paused) return this.schedule(file.path, TIMING.settle);
		const pending = this.inflight.get(file.path);
		if (pending && Date.now() - pending.since < TIMING.inflight) return this.schedule(file.path, 250);
		this.inflight.delete(file.path);
		if (this.unparsed(file)) return;

		const now = readEdges(this.plugin.app, file, this.props());
		const before = this.snapshot.get(file.path) ?? new Map<string, Set<string>>();
		const { settings } = this.plugin;
		if (!settings.autoSync || !this.plugin.relationsValid()) {
			// The user chose not to mirror. Check links finds what is one-sided.
			if (now.size) this.snapshot.set(file.path, now);
			else this.snapshot.delete(file.path);
			return;
		}
		const added: [string, string][] = [];
		const removed: [string, string][] = [];
		for (const [prop, targets] of now) for (const t of targets) if (!before.get(prop)?.has(t)) added.push([prop, t]);
		for (const [prop, targets] of before) for (const t of targets) if (!now.get(prop)?.has(t)) removed.push([prop, t]);
		if (!added.length && !removed.length) return;

		const sides = this.plugin.sides();
		const j = new Journal();
		const notices: string[] = [];
		const removals: { target: TFile; prop: string; text: string }[] = [];
		let failed: unknown = null;
		try {
			for (const [prop, t] of added) {
				const side = sides.get(prop);
				const target = this.file(t);
				if (side && target && target !== file) await this.addBack(j, file, side, target, notices);
				// Only now is this link handled. If a write above failed, the next attempt sees it again.
				this.snap(file.path, prop, t, true);
			}
			for (const [prop, t] of removed) {
				const side = sides.get(prop);
				const target = this.file(t);
				if (side && target && target !== file && settings.mirrorRemovals) {
					const before = j.ops.length;
					if (await this.removeOne(j, target, side.inverse, file.path)) {
						removals.push({ target, prop: side.inverse, text: j.ops[before].text ?? `[[${file.basename}]]` });
					}
				}
				this.snap(file.path, prop, t, false);
			}
			this.attempts.delete(file.path);
		} catch (e) {
			failed = e;
		}
		if (j.ops.length) this.plugin.record(`Updated notes linked from ${file.basename}`, j.ops, false);
		for (const n of notices) new Notice(n, 7000);
		for (const r of removals) this.removalNotice(file, r.target, r.prop, r.text);
		if (j.ops.length) this.healthCache = null;

		if (failed && !(failed instanceof Cancelled)) {
			const n = this.attempts.get(file.path) ?? 0;
			this.plugin.reportError(`Mirroring ${file.basename}`, failed);
			if (n < TIMING.retries.length) {
				this.attempts.set(file.path, n + 1);
				this.schedule(file.path, TIMING.retries[n]);
				if (n === 0) new Notice(`Relate could not update every note linked from ${file.basename}. It will try again shortly.`, 7000);
			} else {
				this.attempts.delete(file.path);
				new Notice(`Relate could not update every note linked from ${file.basename}. Run Check links to see what is one-sided.`, 10000);
			}
		}
	}

	/** Tells the user about a removal on another note, with an Undo that puts the link back on both notes. */
	private removalNotice(source: TFile, target: TFile, prop: string, text: string): void {
		const frag = createFragment((f) => {
			f.appendText(`Also removed ${source.basename} from ${target.basename}'s ${prop}. `);
			const undo = f.createEl("a", { text: "Undo", href: "#" });
			undo.addEventListener("click", (e) => {
				e.preventDefault();
				notice.hide();
				void this.restore(source, target, prop, text);
			});
		});
		const notice = new Notice(frag, 8000);
	}

	private async restore(source: TFile, target: TFile, prop: string, text: string): Promise<void> {
		const side = this.plugin.sides().get(prop);
		if (!side) return;
		const out = await this.batch(`Restored the link between ${source.basename} and ${target.basename}`, true, async (j) => {
			await this.addOne(j, target, prop, source, side.one, { replace: false, text });
			const own = await this.addOne(j, source, side.inverse, target, side.inverseOne, { replace: false });
			if (own.blocked) j.skipped.push(`${source.basename} already has a ${side.inverse}, so Relate could not put ${target.basename} back.`);
		});
		this.report(out, "Relate restored the link.");
	}

	// ----------------------------------------------------------------- explicit actions

	/** Links two notes on both sides, whatever the auto-sync setting. */
	async connect(file: TFile, side: Side, target: TFile): Promise<Outcome> {
		return this.connectMany([{ file, side, target }], `Linked ${file.basename} to ${target.basename}`);
	}

	/**
	 * Links many pairs in one batch, so one Undo reverses all of them. Each pair is checked for loops first,
	 * and a pair that cannot be linked is skipped with a reason while the rest go ahead.
	 */
	async connectMany(pairs: { file: TFile; side: Side; target: TFile }[], label: string): Promise<Outcome> {
		const notices: string[] = [];
		const out = await this.batch(label, true, async (j) => {
			for (const { file, side, target } of pairs) {
				const loop = this.wouldLoop(file, side, target);
				if (loop) {
					j.skipped.push(`Relate did not link ${file.basename} and ${target.basename}, because ${side.relation.property} would then loop back on itself: ${loop.map(name).join(" → ")}.`);
					continue;
				}
				const r = await this.addOne(j, file, side.prop, target, side.one);
				if (r.blocked) {
					j.skipped.push(`${file.basename} already lists more than one ${side.prop}, so Relate left it alone. Run Check links to choose one.`);
					continue;
				}
				if (!r.changed && this.plugin.index.targets(target.path, side.inverse).has(file.path)) {
					if (pairs.length === 1) j.skipped.push(`${file.basename} already lists ${target.basename} under ${side.prop}.`);
					continue;
				}
				if (r.replaced) {
					const old = this.file(r.replaced);
					if (old) {
						await this.removeOne(j, old, side.inverse, file.path);
						notices.push(`${file.basename} can have only one ${side.prop}, so ${target.basename} replaced ${old.basename}.`);
					}
				}
				await this.addBack(j, file, side, target, notices);
			}
		});
		for (const n of notices.slice(0, 3)) new Notice(n, 7000);
		if (notices.length > 3) new Notice(`${notices.length - 3} more notes moved. See Recent changes in Relate's settings.`, 7000);
		return out;
	}

	/**
	 * For relationships that follow chains, the chain a new link would turn into a loop, or null.
	 * Linking A to B under "parent" makes B sit above A, so it loops if A already sits above B.
	 */
	wouldLoop(file: TFile, side: Side, target: TFile): string[] | null {
		const r = side.relation;
		if (!r.chains || r.property === r.inverse) return null;
		if (file === target) return [file.path, file.path];
		const index = this.plugin.index;
		const step = (p: string) => upStep(index, (x, prop) => index.incoming(x, prop), r, p);
		const [below, above] = side.prop === r.property ? [file.path, target.path] : [target.path, file.path];
		const chain = pathUp(step, above, below);
		return chain ? [below, ...chain] : null;
	}

	/** Removes a link from both notes, whatever the auto-sync setting. */
	async disconnect(file: TFile, side: Side, targetPath: string): Promise<Outcome> {
		return this.batch(`Unlinked ${file.basename} and ${name(targetPath)}`, true, async (j) => {
			await this.removeOne(j, file, side.prop, targetPath);
			const target = this.file(targetPath);
			if (target) await this.removeOne(j, target, side.inverse, file.path);
		});
	}

	/** Adds the missing side of a one-way link on `file`, without replacing anything. */
	async fillHere(file: TFile, side: Side, targetPath: string): Promise<Outcome> {
		return this.batch(`Listed ${name(targetPath)} on ${file.basename}`, true, async (j) => {
			const target = this.file(targetPath);
			if (!target) return;
			const r = await this.addOne(j, file, side.prop, target, side.one, { replace: false });
			if (r.blocked) j.skipped.push(`${file.basename} already has a ${side.prop}. Run Check links to choose one.`);
		});
	}

	// ----------------------------------------------------------------- checking and repair

	/** Finds one-way links and broken "only one" rules. Cached until the links change. */
	health(only?: Set<string>): Health {
		const key = `${this.plugin.index.revision}|${JSON.stringify(this.plugin.settings.relations)}`;
		if (!only && this.healthCache?.key === key) return this.healthCache.value;
		const index = this.plugin.index;
		const value = computeHealth(index, this.plugin.sides(), only);
		const relations = this.plugin.relationsValid() ? this.plugin.settings.relations : [];
		value.loops = findLoops(index, (p, prop) => index.incoming(p, prop), relations.filter((r) => !only || only.has(r.property) || only.has(r.inverse)));
		if (!only) this.healthCache = { key, value };
		return value;
	}

	/** Adds the missing side of each link. Rechecks each proposal first and skips any that no longer applies. */
	async repair(items: Missing[], label = "Added one-way links"): Promise<Outcome> {
		return this.batch(label, true, async (j) => {
			const sides = this.plugin.sides();
			for (const m of items) {
				const file = this.file(m.file);
				const target = this.file(m.target);
				const side = sides.get(m.prop);
				if (!file || !target || !side) {
					j.skipped.push(`${name(m.file)} or ${name(m.target)} no longer exists.`);
					continue;
				}
				// The proposal rests on `target` listing `file`. Make sure it still does.
				const claim = readEdges(this.plugin.app, target, [m.via]).get(m.via);
				if (!claim?.has(file.path)) {
					j.skipped.push(`${target.basename} no longer lists ${file.basename} under ${m.via}.`);
					continue;
				}
				const r = await this.addOne(j, file, m.prop, target, side.one, { replace: false });
				if (r.blocked) j.skipped.push(`${file.basename} already has a ${m.prop}.`);
			}
		});
	}

	/** Settles a conflict the way the user chose. Rechecks the notes first and stops if they changed. */
	async resolve(c: Conflict, keep: string): Promise<Outcome> {
		const sides = this.plugin.sides();
		const file = this.file(c.file);
		const chosen = this.file(keep);
		const side = sides.get(c.prop);
		const viaSide = sides.get(c.via);
		return this.batch(`Chose ${name(keep)} as ${name(c.file)}'s ${c.prop}`, true, async (j) => {
			if (!file || !chosen || !side || !viaSide) throw new Error("One of these notes no longer exists.");
			const current = [...(readEdges(this.plugin.app, file, [c.prop]).get(c.prop) ?? [])];
			const claimants = [...this.plugin.index.incoming(file.path, c.via)].filter((p) => {
				const f = this.file(p);
				return f ? !!readEdges(this.plugin.app, f, [c.via]).get(c.via)?.has(file.path) : false;
			});
			const candidates = new Set([...current, ...claimants]);
			if (!candidates.has(keep)) throw new Error(`${chosen.basename} no longer claims ${file.basename}. Check links again to see the current state.`);
			for (const p of candidates) {
				if (p === keep) continue;
				await this.removeOne(j, file, c.prop, p);
				const other = this.file(p);
				if (other) await this.removeOne(j, other, c.via, file.path);
			}
			await this.addOne(j, file, c.prop, chosen, side.one, { replace: false });
			await this.addOne(j, chosen, c.via, file, viaSide.one, { replace: false });
		});
	}

	/**
	 * Reverses recorded changes, newest first. A change already reversed by hand counts as done. A change that
	 * cannot be reversed, because a note is gone or a property is now taken, is returned so it can be tried again.
	 */
	async undo(label: string, ops: HistoryOp[]): Promise<UndoOutcome> {
		const sides = this.plugin.sides();
		const unresolved: HistoryOp[] = [];
		const reasons: string[] = [];
		let done = 0;
		const reversed = [...ops].reverse();
		let i = 0;
		const out = await this.batch(`Undid “${label}”`, false, async (j) => {
			for (; i < reversed.length; i++) {
				const op = reversed[i];
				const file = this.file(op.path);
				if (op.action === "add") {
					// Removing a link from a note that no longer exists, or no longer has it, needs no work.
					if (file) await this.removeOne(j, file, op.prop, op.target);
					done++;
					continue;
				}
				const target = this.file(op.target);
				if (!file || !target) {
					unresolved.push(op);
					reasons.push(`${name(file ? op.target : op.path)} no longer exists.`);
					continue;
				}
				const r = await this.addOne(j, file, op.prop, target, sides.get(op.prop)?.one ?? false, { replace: false, text: op.text });
				if (r.blocked) {
					unresolved.push(op);
					reasons.push(`${file.basename} now has another ${op.prop}.`);
				} else done++;
			}
		});
		if (out.error) {
			// Whatever the batch did not reach stays available to try again.
			unresolved.push(...reversed.slice(i));
			reasons.push(out.error);
		}
		return { done, unresolved: unresolved.reverse(), reasons };
	}

	/** Shows a one-line result for an explicit action, including anything skipped or left undone. */
	report(out: Outcome, success: string): void {
		if (out.error) {
			new Notice(
				out.applied.length
					? `Relate made ${out.applied.length} change${out.applied.length === 1 ? "" : "s"}, then stopped: ${out.error} The changes are listed under Recent changes, where you can undo them.`
					: `Relate could not finish: ${out.error}`,
				10000
			);
		} else if (out.skipped.length) {
			new Notice((out.applied.length && success ? success + " " : "") + out.skipped.slice(0, 3).join(" ") + (out.skipped.length > 3 ? ` ${out.skipped.length - 3} more were skipped.` : ""), 9000);
		} else if (out.applied.length) {
			new Notice(success);
		}
	}
}
