import { TFile } from "obsidian";
import type RelatePlugin from "../main";

/** What search needs from the plugin, and nothing more. */
export type SearchHost = Pick<RelatePlugin, "app" | "connected" | "index" | "relatedDetail" | "reportError" | "semantic" | "settings" | "sides">;
import { LexicalIndex } from "./lexical";
import { parseQuery, type NoteRef, type ParsedQuery } from "./parser";
import { labelOf, normalizeTitle, stripLeadingTag } from "../links";
import { fuse } from "../semantic/core";
import { findPaths, type Step } from "../paths";
import type { RelationChip } from "./parser";

export interface SearchResult {
	file: TFile;
	reasons: string[];
	snippet: string;
	score: number;
	/** How the note meets each multi-step condition, as clickable steps. */
	paths: Step[][];
}

const MAX_RESULTS = 50;

/** Relationship-aware search: relationships and dates narrow the set, words rank it. */
export class SearchService {
	readonly lexical = new LexicalIndex();
	private built: Promise<void> | null = null;
	private names: Map<string, TFile[]> | null = null;
	private dirty = new Set<string>();
	private flushTimer: number | null = null;

	constructor(private plugin: SearchHost) {}

	get ready(): boolean {
		return this.built !== null;
	}

	private body(file: TFile, text: string): string {
		const end = this.plugin.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;
		return end ? text.slice(end) : text;
	}

	/** Builds the word index the first time anyone searches. A note that fails to read is retried later; a failed build is retried on the next search. */
	ensureBuilt(): Promise<void> {
		if (!this.built) {
			const attempt = (async () => {
				const files = this.plugin.app.vault.getMarkdownFiles();
				for (let i = 0; i < files.length; i++) {
					if (this.stopped) return;
					const f = files[i];
					try {
						const text = await this.plugin.app.vault.cachedRead(f);
						this.lexical.set(f.path, f.basename, this.body(f, text));
					} catch {
						this.dirty.add(f.path);
						this.scheduleFlush(5000);
					}
					if (i % 200 === 199) await new Promise((r) => window.setTimeout(r, 0));
				}
			})();
			this.built = attempt.catch((e) => {
				this.built = null;
				throw e;
			});
		}
		return this.built;
	}

	private stopped = false;

	stop(): void {
		this.stopped = true;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
	}

	private scheduleFlush(delay: number): void {
		if (this.stopped) return;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => void this.flush(), delay);
	}

	markDirty(path: string): void {
		this.names = null;
		if (!this.built) return;
		this.dirty.add(path);
		this.scheduleFlush(1000);
	}

	private async flush(): Promise<void> {
		this.flushTimer = null;
		const paths = [...this.dirty];
		this.dirty.clear();
		for (const p of paths) {
			if (this.stopped) return;
			const f = this.plugin.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && f.extension === "md") {
				try {
					this.lexical.set(f.path, f.basename, this.body(f, await this.plugin.app.vault.cachedRead(f)));
				} catch {
					// Keep it dirty and try again shortly.
					this.dirty.add(p);
				}
			} else {
				this.lexical.remove(p);
			}
		}
		if (this.dirty.size) this.scheduleFlush(5000);
	}

	onRename(oldPath: string, newPath: string): void {
		this.names = null;
		this.lexical.rename(oldPath, newPath);
		this.markDirty(newPath);
	}

	onDelete(path: string): void {
		this.names = null;
		this.lexical.remove(path);
	}

	private nameMap(): Map<string, TFile[]> {
		if (this.names) return this.names;
		const map = new Map<string, TFile[]>();
		const add = (name: string, f: TFile) => {
			const key = normalizeTitle(name);
			if (!key) return;
			const list = map.get(key) ?? [];
			if (!list.includes(f)) list.push(f);
			map.set(key, list);
		};
		for (const f of this.plugin.app.vault.getMarkdownFiles()) {
			add(f.basename, f);
			add(stripLeadingTag(f.basename), f);
			const aliases: unknown = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
			for (const a of Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : []) {
				if (typeof a === "string") add(a, f);
			}
		}
		this.names = map;
		return map;
	}

	/** Picks the note a typed span most likely means. Prefers notes that already have relationships. */
	resolve = (span: string): NoteRef | null => {
		const key = normalizeTitle(span);
		if (!key) return null;
		const index = this.plugin.index;
		const pick = (list: TFile[]) =>
			[...list].sort((a, b) => Number(index.hasEdges(b.path)) - Number(index.hasEdges(a.path)) || a.basename.length - b.basename.length)[0];
		const exact = this.nameMap().get(key);
		if (exact?.length) {
			const f = pick(exact);
			return { path: f.path, title: f.basename };
		}
		const words = key.split(" ").length;
		if (words < 2 && key.length < 5) return null;
		const re = new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
		const partial: TFile[] = [];
		for (const [name, files] of this.nameMap()) if (re.test(name)) partial.push(...files);
		if (!partial.length) return null;
		const f = pick([...new Set(partial)]);
		return { path: f.path, title: f.basename };
	};

	labels(): Map<string, string> {
		const map = new Map<string, string>();
		for (const prop of this.plugin.sides().keys()) map.set(labelOf(prop), prop);
		return map;
	}

	parse(query: string): ParsedQuery {
		return parseQuery(query, this.labels(), this.resolve);
	}

	/**
	 * Runs a chain such as "residents of all places of Gondor" from the inside out. A step that follows chains
	 * also keeps the notes it started from, so "all places of Gondor" includes Gondor itself as somewhere to live.
	 */
	runChain(chip: RelationChip): { paths: Set<string>; notes: string[] } {
		const notes: string[] = [];
		let current = new Set([chip.note.path]);
		const steps = [...chip.chain].reverse();
		steps.forEach((step, i) => {
			const next = new Set<string>();
			let truncated = false;
			let followed = false;
			for (const p of current) {
				const r = this.plugin.relatedDetail(p, step.prop, step.all);
				for (const q of r.paths) next.add(q);
				truncated ||= r.truncated;
				followed ||= r.followed;
			}
			if (step.all && !followed) notes.push(`${step.label} does not follow chains`);
			if (truncated) notes.push("first 12 levels only");
			const outermost = i === steps.length - 1;
			if (step.all && followed && !outermost) for (const p of current) next.add(p);
			current = next;
		});
		return { paths: current, notes };
	}

	private dateOf(file: TFile): number | null {
		const s = this.plugin.settings;
		if (s.dateSource === "created") return file.stat.ctime;
		if (s.dateSource === "property" && s.dateProperty) {
			const v: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[s.dateProperty];
			if (typeof v !== "string" && typeof v !== "number") return null;
			const t = new Date(typeof v === "string" ? v.replace(/^@/, "") : v).getTime();
			return Number.isNaN(t) ? null : t;
		}
		return file.stat.mtime;
	}

	/** Runs a parsed query. Other plugins get results without snippets, which cost a file read each. */
	async run(parsed: ParsedQuery, opts: { snippets?: boolean } = {}): Promise<SearchResult[]> {
		const app = this.plugin.app;
		const reasons = new Map<string, string[]>();
		const explain: RelationChip[] = [];
		const note = (path: string, why: string) => {
			const list = reasons.get(path) ?? [];
			list.push(why);
			reasons.set(path, list);
		};
		let set: Set<string> | null = null;
		const narrow = (next: Set<string>, why: string) => {
			set = set ? new Set([...set].filter((p) => next.has(p))) : next;
			for (const p of set) note(p, why);
		};

		for (const chip of parsed.chips) {
			if (chip.kind === "relation") {
				const { paths, notes: chainNotes } = this.runChain(chip);
				let why = chip.chain.map((c) => `${c.all ? "all " : ""}${c.label} of `).join("") + chip.note.title;
				if (chainNotes.length) why += ` (${chainNotes.join("; ")})`;
				narrow(paths, why);
				if (chip.chain.length > 1 || chip.all) explain.push(chip);
			} else if (chip.kind === "connected") {
				narrow(this.plugin.connected(chip.note.path), `connected to ${chip.note.title}`);
			}
		}
		const date = parsed.chips.find((c) => c.kind === "date");
		if (date && date.kind === "date") {
			const pool: Iterable<string> = set ?? app.vault.getMarkdownFiles().map((f) => f.path);
			const inRange = new Set<string>();
			for (const p of pool) {
				const f = app.vault.getAbstractFileByPath(p);
				if (!(f instanceof TFile)) continue;
				const t = this.dateOf(f);
				if (t !== null && t >= date.from && t < date.to) inRange.add(p);
			}
			set = inRange;
			for (const p of inRange) note(p, date.label);
		}

		const out: SearchResult[] = [];
		const push = (path: string, score: number, matched: string[]) => {
			const f = app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			const why = [...(reasons.get(path) ?? [])];
			if (matched.length) why.push(`mentions ${matched.join(", ")}`);
			out.push({ file: f, reasons: why, snippet: "", score, paths: [] });
		};

		if (parsed.text) {
			await this.ensureBuilt();
			const words = this.lexical.search(parsed.text, set, MAX_RESULTS);
			// A failing meaning search, such as an unreachable server, leaves word search working.
			let meaning: Awaited<ReturnType<typeof this.plugin.semantic.search>> = [];
			if (this.plugin.semantic.ready) {
				try {
					meaning = await this.plugin.semantic.search(parsed.text, set, 20);
				} catch (e) {
					this.plugin.reportError("Search by meaning", e);
				}
			}
			if (meaning.length) {
				// Merge both rankings, so a note that matches the words or the meaning well rises to the top.
				const matched = new Map(words.map((h) => [h.path, h.matched]));
				const close = new Set(meaning.map((h) => h.path));
				const fused = fuse([words.map((h) => h.path), meaning.map((h) => h.path)]);
				for (const [path, score] of [...fused].sort((a, b) => b[1] - a[1]).slice(0, MAX_RESULTS)) {
					push(path, score, matched.get(path) ?? []);
					const last = out[out.length - 1];
					if (last?.file.path === path && close.has(path) && !matched.has(path)) last.reasons.push("similar in meaning");
				}
			} else {
				for (const hit of words) push(hit.path, hit.score, hit.matched);
			}
			// Title-only fallback keeps results useful while the word index is still filling.
			if (!out.length && !set) {
				const key = normalizeTitle(parsed.text);
				for (const f of app.vault.getMarkdownFiles()) {
					if (normalizeTitle(f.basename).includes(key)) push(f.path, 1, []);
					if (out.length >= MAX_RESULTS) break;
				}
			}
		} else if (set) {
			const files = [...set]
				.map((p) => app.vault.getAbstractFileByPath(p))
				.filter((f): f is TFile => f instanceof TFile)
				.sort((a, b) => (this.dateOf(b) ?? 0) - (this.dateOf(a) ?? 0));
			for (const f of files.slice(0, MAX_RESULTS)) push(f.path, 0, []);
		}

		// For multi-step conditions, show the route behind each of the first results.
		if (explain.length) {
			const sides = this.plugin.sides();
			for (const r of out.slice(0, 30)) {
				for (const chip of explain) {
					const props = new Set(chip.chain.map((c) => sides.get(c.prop)?.inverse ?? c.prop));
					const [best] = findPaths(this.plugin.index, sides, r.file.path, chip.note.path, { props, maxSteps: 16, limit: 1 });
					if (best && best.length > 1) r.paths.push(best);
				}
			}
		}

		const terms = parsed.text ? parsed.text.toLowerCase().split(/\s+/).filter((t) => t.length > 1) : [];
		if (terms.length && opts.snippets !== false) {
			await Promise.all(out.slice(0, 20).map(async (r) => (r.snippet = this.snippet(r.file, await app.vault.cachedRead(r.file), terms))));
		}
		return out;
	}

	private snippet(file: TFile, text: string, terms: string[]): string {
		const body = this.body(file, text);
		const lower = body.toLowerCase();
		let at = -1;
		for (const t of terms) {
			const i = lower.indexOf(t);
			if (i >= 0 && (at < 0 || i < at)) at = i;
		}
		if (at < 0) {
			// A note found by meaning may not contain the words, so show how it opens.
			const opening = body.replace(/^\s*#.*$/m, "").replace(/\s+/g, " ").trim();
			return opening ? opening.slice(0, 160) + (opening.length > 160 ? "…" : "") : "";
		}
		const start = Math.max(0, at - 60);
		const raw = body.slice(start, at + 120).replace(/\s+/g, " ").trim();
		return (start > 0 ? "…" : "") + raw + "…";
	}
}
