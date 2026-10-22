import { showPaths } from "./paths-modal";
import { ItemView, Keymap, TFile, ViewStateResult, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { icons } from "./icons";
import type RelatePlugin from "../main";
import type { Relation, Side } from "../settings";
import { SearchModal } from "./search-modal";
import { HealthModal } from "./modals";
import { noteNamer } from "../links";

export const BROWSER_VIEW = "relate-browser";

interface BrowserState {
	relation: string;
	path: string[];
}

interface Entry {
	path: string;
	/** Only the other note records this link. */
	oneWay: boolean;
}

interface Group {
	label: string;
	entries: Entry[];
}

const ALL = "";
const PREVIEW_CHARS = 600;

/**
 * Browses relationships in columns. The first column lists starting notes. Selecting a note opens a
 * column with that note's connections, grouped by relationship, and so on. A preview of the last
 * selected note closes the row.
 */
export class BrowserView extends ItemView {
	private browseRelation = ALL;
	/** Selected note in each column. */
	private browsePath: string[] = [];
	private focusColumn = 0;
	private filterText = "";
	private columnsEl!: HTMLElement;
	private filterEl!: HTMLInputElement;
	private relationEl!: HTMLSelectElement;
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: RelatePlugin) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return BROWSER_VIEW;
	}
	getDisplayText(): string {
		return "Relationships";
	}
	getIcon(): string {
		return icons.browser();
	}

	getState(): Record<string, unknown> {
		return { relation: this.browseRelation, path: this.browsePath };
	}

	async setState(state: Partial<BrowserState>, result: ViewStateResult): Promise<void> {
		if (typeof state?.relation === "string") this.browseRelation = state.relation;
		if (Array.isArray(state?.path)) this.browsePath = state.path.filter((p): p is string => typeof p === "string");
		this.focusColumn = Math.max(0, this.browsePath.length - 1);
		await super.setState(state, result);
		this.render();
	}

	/** Opens the browser on one note, with every relationship shown. */
	focusNote(path: string): void {
		this.browseRelation = ALL;
		this.filterText = "";
		this.browsePath = [path];
		this.focusColumn = 0;
		this.render();
	}

	async onOpen(): Promise<void> {
		try {
			this.build();
		} catch (e) {
			this.showError(e);
		}
	}

	private showError(e: unknown): void {
		const msg = this.plugin.reportError("Relationship browser", e);
		this.contentEl.empty();
		this.contentEl.createDiv({ cls: "pane-empty relate-browser-empty", text: `Relate could not draw the browser: ${msg}` });
	}

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("relate-browser");

		const bar = root.createDiv({ cls: "relate-browser-bar" });
		this.relationEl = bar.createEl("select", { cls: "dropdown" });
		this.relationEl.addEventListener("change", () => {
			this.browseRelation = this.relationEl.value;
			this.browsePath = [];
			this.focusColumn = 0;
			this.render();
		});
		this.filterEl = bar.createEl("input", { type: "search", cls: "relate-browser-filter", attr: { placeholder: "Filter the first column" } });
		this.filterEl.addEventListener("input", () => {
			this.filterText = this.filterEl.value.trim().toLowerCase();
			this.render();
		});
		const spacer = bar.createDiv({ cls: "relate-browser-spacer" });
		spacer.setAttr("aria-hidden", "true");
		this.barButton(bar, "search", "Search notes", () => new SearchModal(this.plugin).open());
		this.barButton(bar, icons.checkLinks(), "Check links", () => new HealthModal(this.plugin).open());

		this.columnsEl = root.createDiv({ cls: "relate-columns", attr: { tabindex: "0" } });
		this.columnsEl.addEventListener("keydown", (e) => this.onKey(e));
		this.render();
	}

	private barButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void): void {
		const b = parent.createEl("button", { cls: "clickable-icon relate-button-reset", attr: { "aria-label": tip, type: "button" } });
		setIcon(b, icon);
		setTooltip(b, tip);
		b.addEventListener("click", onClick);
	}

	private namer: (path: string) => string = (p) => p.replace(/^.*\//, "").replace(/\.md$/, "");

	private noteName(path: string): string {
		return this.namer(path);
	}

	private relations(): Relation[] {
		return this.plugin.relationsValid() ? this.plugin.settings.relations.filter((r) => r.property && r.inverse) : [];
	}

	private selectedRelation(): Relation | null {
		return this.relations().find((r) => r.property === this.browseRelation) ?? null;
	}

	private relationLabel(r: Relation): string {
		return r.property === r.inverse ? r.property : `${r.property} and ${r.inverse}`;
	}

	/** Notes in the first column. */
	private roots(): string[] {
		const r = this.selectedRelation();
		let paths: string[];
		if (!r) {
			const counts = new Map<string, number>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				const n = this.plugin.connected(f.path).size;
				if (n) counts.set(f.path, n);
			}
			paths = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || this.noteName(a).localeCompare(this.noteName(b)));
		} else {
			// Starting notes are the ones others point to: projects for "project", parents for "parent".
			const hubs = new Set<string>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				if (this.plugin.related(f.path, r.inverse, false).size) hubs.add(f.path);
			}
			// In a tree, start from the top: hubs that have no parent of their own.
			if (r.propertyOne && r.property !== r.inverse) {
				for (const h of [...hubs]) if (this.plugin.related(h, r.property, false).size) hubs.delete(h);
			}
			paths = [...hubs].sort((a, b) => this.noteName(a).localeCompare(this.noteName(b)));
		}
		if (this.filterText) paths = paths.filter((p) => this.noteName(p).toLowerCase().includes(this.filterText));
		// Keep a focused note visible even when it is not a natural starting point.
		if (this.browsePath[0] && !paths.includes(this.browsePath[0]) && !this.filterText) paths.unshift(this.browsePath[0]);
		return paths;
	}

	/** A note's connections, grouped by relationship. The chosen relationship comes first. */
	private groups(path: string): Group[] {
		const index = this.plugin.index;
		const sides = [...this.plugin.sides().values()];
		const chosen = this.selectedRelation();
		const rank = (s: Side) => (chosen && (s.prop === chosen.property || s.prop === chosen.inverse) ? 0 : 1);
		sides.sort((a, b) => rank(a) - rank(b));
		const out: Group[] = [];
		for (const side of sides) {
			const listed = index.targets(path, side.prop);
			const oneWay = [...index.incoming(path, side.inverse)].filter((p) => !listed.has(p) && p !== path);
			const entries: Entry[] = [
				...[...listed].map((p) => ({ path: p, oneWay: false })),
				...oneWay.map((p) => ({ path: p, oneWay: true })),
			].sort((a, b) => this.noteName(a.path).localeCompare(this.noteName(b.path)));
			if (entries.length) out.push({ label: side.prop, entries });
		}
		return out;
	}

	render(): void {
		try {
			this.draw();
		} catch (e) {
			this.showError(e);
		}
	}

	private draw(): void {
		if (!this.columnsEl) return;
		this.namer = noteNamer(this.app.vault.getMarkdownFiles().map((f) => f.path));
		const token = ++this.renderToken;
		this.renderRelationPicker();
		const cols = this.columnsEl;
		const scrollLeft = cols.scrollLeft;
		cols.empty();

		if (!this.plugin.sides().size) {
			const empty = cols.createDiv({ cls: "pane-empty relate-browser-empty" });
			empty.setText("Set up a relationship first: run the command to find links in your vault, or open Relate's settings.");
			return;
		}

		const roots = this.roots();
		// Drop a stale path when its notes no longer exist.
		this.browsePath = this.browsePath.filter((p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile);
		const first = this.makeColumn(cols, 0);
		if (!roots.length) {
			first.createDiv({ cls: "pane-empty", text: this.filterText ? "No notes match the filter." : "No notes use this relationship yet." });
		} else {
			this.drawList(first, 0, [{ label: "", entries: roots.map((p) => ({ path: p, oneWay: false })) }]);
		}

		for (let k = 0; k < this.browsePath.length; k++) {
			const groups = this.groups(this.browsePath[k]);
			if (!groups.length) break;
			const col = this.makeColumn(cols, k + 1);
			this.drawList(col, k + 1, groups);
		}
		const last = this.browsePath[this.browsePath.length - 1];
		if (last) this.drawPreview(cols, last, token).catch((e) => this.plugin.reportError("Relationship browser preview", e));

		window.requestAnimationFrame(() => {
			cols.scrollLeft = scrollLeft;
			cols.querySelector(".relate-col.is-focused .is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
			const focused = cols.querySelector(".relate-col.is-focused");
			focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
		});
	}

	private renderRelationPicker(): void {
		const sel = this.relationEl;
		sel.empty();
		sel.createEl("option", { value: ALL, text: "All relationships" });
		for (const r of this.relations()) sel.createEl("option", { value: r.property, text: this.relationLabel(r) });
		if (!this.selectedRelation()) this.browseRelation = ALL;
		sel.value = this.browseRelation;
	}

	private makeColumn(parent: HTMLElement, k: number): HTMLElement {
		const col = parent.createDiv({ cls: "relate-col" + (k === this.focusColumn ? " is-focused" : "") });
		col.addEventListener("click", () => {
			this.focusColumn = k;
			this.columnsEl.focus();
		});
		return col;
	}

	private drawList(col: HTMLElement, k: number, groups: Group[]): void {
		const selected = this.browsePath[k];
		for (const g of groups) {
			if (g.label) {
				const head = col.createDiv({ cls: "relate-col-heading" });
				head.createSpan({ text: g.label });
				head.createSpan({ cls: "relate-col-heading-count", text: String(g.entries.length) });
			}
			for (const e of g.entries) {
				const n = this.plugin.connected(e.path).size;
				const row = col.createDiv({
					cls: "tree-item-self is-clickable relate-col-item" + (e.path === selected ? " is-active" : "") + (e.oneWay ? " is-one-way" : ""),
					attr: { "data-path": e.path },
				});
				row.createDiv({ cls: "tree-item-inner", text: this.noteName(e.path) });
				if (e.oneWay) setTooltip(row, `${this.noteName(e.path)} lists this note, but this note does not list it back.`, { placement: "right" });
				const flair = row.createDiv({ cls: "tree-item-flair-outer" });
				if (n) flair.createSpan({ cls: "tree-item-flair", text: String(n) });
				const chevron = row.createDiv({ cls: "relate-col-chevron" });
				if (n) setIcon(chevron, "chevron-right");
				row.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.selectNote(k, e.path);
				});
				row.addEventListener("dblclick", (evt) => void this.openNote(e.path, evt));
				row.addEventListener("mouseover", (evt) =>
					this.app.workspace.trigger("hover-link", { event: evt, source: BROWSER_VIEW, hoverParent: this, targetEl: row, linktext: e.path })
				);
			}
		}
	}

	private selectNote(k: number, path: string): void {
		this.browsePath = [...this.browsePath.slice(0, k), path];
		this.focusColumn = k;
		this.columnsEl.focus();
		this.render();
	}

	/** The pane beside the browser that "Open note" reuses, so repeated opens do not stack up splits. */
	private noteLeaf: WorkspaceLeaf | null = null;

	private async openNote(path: string, evt?: MouseEvent | KeyboardEvent): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		if (evt && Keymap.isModEvent(evt)) {
			await this.app.workspace.getLeaf("tab").openFile(f);
			return;
		}
		let attached = false;
		this.app.workspace.iterateAllLeaves((l) => {
			if (l === this.noteLeaf) attached = true;
		});
		const leaf = attached && this.noteLeaf ? this.noteLeaf : this.app.workspace.getLeaf("split", "vertical");
		this.noteLeaf = leaf;
		await leaf.openFile(f);
	}

	private async drawPreview(parent: HTMLElement, path: string, token: number): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		const pane = parent.createDiv({ cls: "relate-col relate-preview-col" });
		pane.createDiv({ cls: "relate-preview-title", text: f.basename });
		if (f.parent && f.parent.path !== "/") pane.createDiv({ cls: "relate-preview-folder", text: f.parent.path });
		const actions = pane.createDiv({ cls: "relate-preview-actions" });
		const openBtn = actions.createEl("button", { cls: "mod-cta", text: "Open note" });
		openBtn.addEventListener("click", (e) => void this.openNote(path, e));
		const tabBtn = actions.createEl("button", { text: "Open in new tab" });
		tabBtn.addEventListener("click", () => {
			void this.app.workspace.getLeaf("tab").openFile(f);
		});
		const pathBtn = actions.createEl("button", { text: "How is it connected to…" });
		pathBtn.addEventListener("click", () => showPaths(this.plugin, f));

		const counts = this.groups(path);
		if (counts.length) {
			const summary = pane.createDiv({ cls: "relate-preview-summary" });
			for (const g of counts) {
				const line = summary.createDiv();
				line.createSpan({ cls: "relate-preview-key", text: g.label });
				line.createSpan({ text: String(g.entries.length) });
			}
		}

		const similar = this.plugin.semantic.similar(path, 5);
		if (similar.length) {
			pane.createDiv({ cls: "relate-preview-heading", text: "Similar notes" });
			const list = pane.createDiv({ cls: "relate-preview-similar" });
			for (const h of similar) {
				const a = list.createEl("a", { cls: "internal-link", text: this.noteName(h.path), href: "#" });
				setTooltip(a, `Similar in meaning (${Math.round(h.score * 100)}%). Click to browse from it.`);
				a.addEventListener("click", (e) => {
					e.preventDefault();
					this.focusNote(h.path);
				});
			}
		}

		const text = await this.app.vault.cachedRead(f);
		if (token !== this.renderToken) return;
		const end = this.app.metadataCache.getFileCache(f)?.frontmatterPosition?.end.offset ?? 0;
		const body = text
			.slice(end)
			.replace(/!\[\[[^\]]*\]\]/g, "")
			.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
			.replace(/^#+\s*/gm, "")
			.replace(/[*_`>]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (body) pane.createDiv({ cls: "relate-preview-text", text: body.length > PREVIEW_CHARS ? body.slice(0, PREVIEW_CHARS).trimEnd() + "…" : body });
	}

	/** Arrow keys move through a column and across columns; Enter opens the note. */
	private onKey(e: KeyboardEvent): void {
		const cols = [...this.columnsEl.querySelectorAll<HTMLElement>(".relate-col:not(.relate-preview-col)")];
		const col = cols[this.focusColumn];
		if (!col) return;
		const rows = [...col.querySelectorAll<HTMLElement>(".relate-col-item")];
		const current = rows.findIndex((r) => r.hasClass("is-active"));
		const pick = (i: number) => {
			const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
			if (row) this.selectNote(this.focusColumn, row.dataset.path ?? "");
		};
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				pick(current + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				pick(current < 0 ? 0 : current - 1);
				break;
			case "ArrowRight": {
				e.preventDefault();
				const next = cols[this.focusColumn + 1];
				const firstRow = next?.querySelector<HTMLElement>(".relate-col-item");
				if (firstRow) this.selectNote(this.focusColumn + 1, firstRow.dataset.path ?? "");
				break;
			}
			case "ArrowLeft":
				e.preventDefault();
				if (this.focusColumn > 0) {
					this.browsePath = this.browsePath.slice(0, this.focusColumn);
					this.focusColumn--;
					this.render();
				}
				break;
			case "Enter":
				e.preventDefault();
				if (this.browsePath[this.focusColumn]) void this.openNote(this.browsePath[this.focusColumn], e);
				break;
		}
	}
}
