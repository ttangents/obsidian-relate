import { App, TFile, getLinkpath } from "obsidian";
import { parseWikilink, toArray } from "./links";

/** What adding a link did to a note. */
export interface AddResult {
	changed: boolean;
	/** Path of the note this link replaced, when the property holds only one link. */
	replaced: string | null;
	/** The original text of the replaced value, so undo can restore it exactly. */
	replacedText: string | null;
	/** The slot already held another note and replacing was not allowed. */
	blocked: boolean;
}

/** How to add a link. */
export interface AddOptions {
	/** For "only one" properties: allow replacing an existing link. */
	replace?: boolean;
	/** Exact text to write, e.g. "[[Note|Alias]]" when undo restores a value. */
	text?: string;
	/**
	 * False when Obsidian's cache of the note may be stale, because Relate wrote the note and Obsidian has not
	 * re-read it yet. The writer then decides from the file itself instead of the cache. Defaults to true.
	 */
	fresh?: boolean;
}

/** Writes and removes links in note properties through Obsidian's own frontmatter API. Never touches the note body. */
export class Writer {
	constructor(private app: App) {}

	linkText(target: TFile, source: TFile): string {
		return `[[${this.app.metadataCache.fileToLinktext(target, source.path, true)}]]`;
	}

	/** Path of the note a property value links to, or null for plain text, unresolved links, and non-note files. */
	resolve(value: unknown, sourcePath: string): string | null {
		const lp = parseWikilink(value);
		if (!lp) return null;
		const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(lp), sourcePath);
		return dest && dest.extension === "md" ? dest.path : null;
	}

	private cached(file: TFile, prop: string): unknown[] {
		return toArray(this.app.metadataCache.getFileCache(file)?.frontmatter?.[prop]);
	}

	async addLink(file: TFile, prop: string, target: TFile, one: boolean, opts: AddOptions = {}): Promise<AddResult> {
		const result: AddResult = { changed: false, replaced: null, replacedText: null, blocked: false };
		if (file.extension !== "md" || target.extension !== "md") return result;
		// Skip the write entirely when an up-to-date cache already shows the link.
		if ((opts.fresh ?? true) && this.cached(file, prop).some((v) => this.resolve(v, file.path) === target.path)) return result;
		const replace = opts.replace ?? true;
		const text = opts.text ?? this.linkText(target, file);

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const current = fm[prop];
			const values = toArray(current);
			if (values.some((v) => this.resolve(v, file.path) === target.path)) return;
			if (one) {
				const linked = values.filter((v) => this.resolve(v, file.path) !== null);
				if (linked.length > 1 || (linked.length === 1 && !replace)) {
					result.blocked = true;
					return;
				}
				if (linked.length === 1) {
					result.replaced = this.resolve(linked[0], file.path);
					result.replacedText = String(linked[0]);
				}
				// Keep plain text and unresolved links; swap only the one resolving link.
				const kept = values.filter((v) => v !== linked[0]);
				result.changed = true;
				fm[prop] = kept.length ? [...kept, text] : Array.isArray(current) ? [text] : text;
				return;
			}
			result.changed = true;
			if (Array.isArray(current)) current.push(text);
			else fm[prop] = values.length ? [...values, text] : [text];
		});
		return result;
	}

	/**
	 * Removes links to `targetPath` and returns the exact text removed, or null when nothing changed. With `fresh`
	 * false, as for `addLink`, the decision comes from the file itself instead of a cache that may be stale.
	 */
	async removeLink(file: TFile, prop: string, targetPath: string, fresh = true): Promise<string | null> {
		if (file.extension !== "md") return null;
		// Skip the write entirely when an up-to-date cache shows nothing to remove.
		if (fresh && !this.cached(file, prop).some((v) => this.resolve(v, file.path) === targetPath)) return null;
		let removed: string | null = null;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const current = fm[prop];
			if (current === undefined) return;
			if (Array.isArray(current)) {
				const kept = current.filter((v) => {
					const hit = this.resolve(v, file.path) === targetPath;
					if (hit && removed === null) removed = String(v);
					return !hit;
				});
				if (kept.length === current.length) return;
				if (kept.length) fm[prop] = kept;
				else delete fm[prop];
			} else if (this.resolve(current, file.path) === targetPath) {
				removed = typeof current === "string" ? current : JSON.stringify(current);
				delete fm[prop];
			}
		});
		return removed;
	}
}
