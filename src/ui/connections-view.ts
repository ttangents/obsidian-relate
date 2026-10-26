import { ItemView, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { icons } from "./icons";
import { renderUpdateNotice } from "./whats-new";
import type RelatePlugin from "../main";
import { AdoptModal, HealthModal, SidePickerModal } from "./modals";
import { linkMenu } from "./linking";
import { noteNamer, plural } from "../links";

/** The Connections panel's view type. */
export const VIEW_TYPE = "relate-connections";

/** Makes a row reachable with Tab and usable with Enter or Space, like a button. */
function activatable(el: HTMLElement, label?: string): HTMLElement {
	el.setAttr("tabindex", "0");
	el.setAttr("role", "button");
	if (label) el.setAttr("aria-label", label);
	el.addEventListener("keydown", (e) => {
		if (e.target !== el) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			el.click();
		}
	});
	return el;
}

/** One-line summary of the vault's link problems, or "" when there are none. */
function issueSummary(missing: number, choices: number, loops = 0, needs = 0): string {
	const parts: string[] = [];
	if (loops) parts.push(plural(loops, "loop", "loops"));
	if (missing) parts.push(plural(missing, "one-way link", "one-way links"));
	if (choices) parts.push(plural(choices, "choice to make", "choices to make"));
	if (needs) parts.push(needs === 1 ? "1 note that needs a link" : `${needs} notes that need a link`);
	return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
}

/**
 * The open note's connections, drawn with the same tree markup as Obsidian's Backlinks and Outline panes,
 * so fonts, spacing and collapse arrows match the core sidebars.
 */
export class ConnectionsView extends ItemView {
	private file: TFile | null = null;
	/** When set, the panel stays on this note while other notes are opened. */
	private pinned: string | null = null;
	private collapsed = new Set<string>();

	constructor(leaf: WorkspaceLeaf, private plugin: RelatePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Connections";
	}
	getIcon(): string {
		return icons.main();
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on("file-open", (f) => this.show(f)));
		this.show(this.app.workspace.getActiveFile());
	}

	getState(): Record<string, unknown> {
		return { pinned: this.pinned };
	}

	async setState(state: { pinned?: unknown }, result: import("obsidian").ViewStateResult): Promise<void> {
		this.pinned = typeof state?.pinned === "string" ? state.pinned : null;
		const f = this.pinned ? this.app.vault.getAbstractFileByPath(this.pinned) : null;
		if (f instanceof TFile) this.file = f;
		else this.pinned = null;
		await super.setState(state, result);
		this.render();
	}

	private setPinned(path: string | null): void {
		this.pinned = path;
		if (!path) this.file = this.app.workspace.getActiveFile();
		this.app.workspace.requestSaveLayout();
		this.render();
	}

	private show(file: TFile | null): void {
		if (this.pinned) return;
		if (file && file.extension !== "md") return;
		this.file = file;
		this.render();
	}

	private navButton(parent: HTMLElement, icon: string, tip: string, onClick: (e: MouseEvent) => void): void {
		const b = parent.createEl("button", { cls: "clickable-icon nav-action-button relate-button-reset", attr: { "aria-label": tip, type: "button" } });
		setIcon(b, icon);
		setTooltip(b, tip);
		b.addEventListener("click", onClick);
	}

	private actionIcon(parent: HTMLElement, icon: string, tip: string, onClick: (e: MouseEvent) => void, cls = ""): void {
		const b = parent.createEl("button", { cls: `clickable-icon relate-action relate-button-reset ${cls}`.trim(), attr: { "aria-label": tip, type: "button" } });
		setIcon(b, icon);
		setTooltip(b, tip);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick(e);
		});
	}

	async onClose(): Promise<void> {
		if (!this.plugin.unloading) {
			this.plugin.settings.panelClosed = true;
			void this.plugin.saveSettings();
		}
	}

	render(): void {
		try {
			this.draw();
		} catch (e) {
			const msg = this.plugin.reportError("Connections panel", e);
			this.contentEl.empty();
			this.contentEl.createDiv({ cls: "pane-empty", text: `Relate could not draw this panel: ${msg}` });
		}
	}

	private draw(): void {
		this.namer = noteNamer(this.app.vault.getMarkdownFiles().map((f) => f.path));
		const el = this.contentEl;
		el.empty();
		el.addClass("relate-view");
		const sides = this.plugin.sides();
		const file = this.file;

		if (sides.size) {
			const header = el.createDiv({ cls: "nav-header" });
			const buttons = header.createDiv({ cls: "nav-buttons-container" });
			if (file) this.navButton(buttons, "plus", "Link a note", (e) => linkMenu(this.plugin, file, e));
			if (file || this.pinned)
				this.navButton(buttons, this.pinned ? "pin-off" : "pin", this.pinned ? "Unpin, and follow the open note again" : `Pin to ${file?.basename}, so the panel stays on it`, () =>
					this.setPinned(this.pinned ? null : file?.path ?? null)
				);
			this.navButton(buttons, icons.browser(), "Open in the relationship browser", () => void this.plugin.openBrowser(file?.path));
			this.navButton(buttons, icons.checkLinks(), "Check links", () => new HealthModal(this.plugin).open());
		}

		if (this.plugin.releases.notes.length) {
			renderUpdateNotice(el, this.plugin.releases.notes, () => this.plugin.showWhatsNew(), () => this.plugin.dismissReleaseNotes());
		}
		const body = el.createDiv({ cls: "relate-view-body" });
		if (!sides.size) {
			this.renderWelcome(body);
			return;
		}
		if (this.pinned && file) {
			const bar = activatable(body.createDiv({ cls: "tree-item-self is-clickable relate-pinned" }), `Pinned to ${file.basename}. Open it`);
			const icon = bar.createDiv({ cls: "tree-item-icon" });
			setIcon(icon, "pin");
			bar.createDiv({ cls: "tree-item-inner", text: `Pinned to ${file.basename}` });
			bar.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(file));
		}
		if (!file) {
			body.createDiv({ cls: "pane-empty", text: "Open a note to see its connections." });
			this.renderIssues(body);
			return;
		}

		const index = this.plugin.index;
		let shown = 0;
		for (const side of sides.values()) {
			const listed = index.targets(file.path, side.prop);
			const oneWay = [...index.incoming(file.path, side.inverse)].filter((p) => !listed.has(p) && p !== file.path);
			if (!listed.size && !oneWay.length) continue;
			shown++;

			const item = body.createDiv({ cls: "tree-item" + (this.collapsed.has(side.prop) ? " is-collapsed" : "") });
			const self = activatable(item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible relate-group" }));
			const arrow = self.createDiv({ cls: "tree-item-icon collapse-icon" + (this.collapsed.has(side.prop) ? " is-collapsed" : "") });
			setIcon(arrow, "right-triangle");
			self.createDiv({ cls: "tree-item-inner", text: side.prop });
			const flair = self.createDiv({ cls: "tree-item-flair-outer" });
			this.actionIcon(flair, "plus", `Add a note under ${side.prop}`, (e) => linkMenu(this.plugin, file, e, side), "relate-hover-only");
			flair.createSpan({ cls: "tree-item-flair", text: String(listed.size + oneWay.length) });
			self.addEventListener("click", () => {
				if (this.collapsed.has(side.prop)) this.collapsed.delete(side.prop);
				else this.collapsed.add(side.prop);
				this.render();
			});

			const children = item.createDiv({ cls: "tree-item-children" });
			for (const p of this.sorted(listed)) this.row(children, p, file, side.prop, false);
			for (const p of this.sorted(oneWay)) this.row(children, p, file, side.prop, true);
		}

		if (!shown) {
			body.createDiv({ cls: "pane-empty", text: "This note has no connections yet." });
		}
		this.renderSimilar(body, file);
		this.renderIssues(body);
	}

	/** Notes close in meaning to this one, when search by meaning is on. */
	private renderSimilar(body: HTMLElement, file: TFile): void {
		const sem = this.plugin.semantic;
		const state = sem.status.state;
		if (state === "off") return;
		const key = "\u0000similar";
		const item = body.createDiv({ cls: "tree-item relate-similar" + (this.collapsed.has(key) ? " is-collapsed" : "") });
		const self = activatable(item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible relate-group" }));
		const arrow = self.createDiv({ cls: "tree-item-icon collapse-icon" + (this.collapsed.has(key) ? " is-collapsed" : "") });
		setIcon(arrow, "right-triangle");
		self.createDiv({ cls: "tree-item-inner", text: "Similar notes" });
		self.addEventListener("click", () => {
			if (this.collapsed.has(key)) this.collapsed.delete(key);
			else this.collapsed.add(key);
			this.render();
		});
		const children = item.createDiv({ cls: "tree-item-children" });
		const note = (text: string) => children.createDiv({ cls: "tree-item-self relate-note-row" }).createDiv({ cls: "tree-item-inner", text });

		if (state === "needs-download") {
			const row = activatable(children.createDiv({ cls: "tree-item-self is-clickable relate-note-row" }));
			row.createDiv({ cls: "tree-item-inner", text: "Download the model on this device" });
			setTooltip(row, sem.status.message);
			row.addEventListener("click", () => this.plugin.turnOnMeaning());
			return;
		}
		if (state === "downloading" || state === "preparing") return void note(sem.status.message);
		if (state === "error") return void note("Search by meaning stopped. See Relate's settings.");
		const hits = sem.similar(file.path, 5);
		if (!hits.length) {
			note(state === "indexing" ? `Indexing notes, ${sem.status.done} of ${sem.status.total}` : "No close matches.");
			return;
		}
		for (const h of hits) {
			const row = activatable(children.createDiv({ cls: "tree-item-self is-clickable relate-item" }));
			row.createDiv({ cls: "tree-item-inner", text: this.name(h.path) });
			setTooltip(row, `Similar in meaning (${Math.round(h.score * 100)}%)`);
			const flair = row.createDiv({ cls: "tree-item-flair-outer" });
			this.actionIcon(
				flair,
				"link",
				`Link ${this.name(h.path)} to this note`,
				() => {
					const target = this.app.vault.getAbstractFileByPath(h.path);
					if (!(target instanceof TFile)) return;
					new SidePickerModal(this.plugin, file, (side) => void this.plugin.connect(file, side, target), `Link ${target.basename} as…`).open();
				},
				"relate-hover-only"
			);
			row.addEventListener("click", (e) => {
				const target = this.app.vault.getAbstractFileByPath(h.path);
				if (target instanceof TFile) void this.app.workspace.getLeaf(e.metaKey || e.ctrlKey ? "tab" : false).openFile(target);
			});
			row.addEventListener("mouseover", (e) =>
				this.app.workspace.trigger("hover-link", { event: e, source: VIEW_TYPE, hoverParent: this, targetEl: row, linktext: h.path })
			);
		}
	}

	private renderWelcome(el: HTMLElement): void {
		const box = el.createDiv({ cls: "relate-welcome" });
		box.createDiv({ cls: "relate-welcome-title", text: "Link notes both ways" });
		box.createDiv({
			cls: "relate-welcome-text",
			text: "When one note lists another in a property, Relate adds the link back on the other note. A project lists its notes, and each note lists its project.",
		});
		const find = box.createEl("button", { cls: "mod-cta", text: "Find links in your vault" });
		find.addEventListener("click", () => new AdoptModal(this.plugin).open());
		box.createDiv({ cls: "relate-welcome-text", text: "To set one up by hand, open Settings, then Relate." });
	}

	/** Vault-wide problems, kept apart from the note's own links so the count is not mistaken for this note's. */
	private renderIssues(el: HTMLElement): void {
		if (this.plugin.sync.busy) return;
		const { missing, conflicts, loops, needs } = this.plugin.sync.health();
		const summary = issueSummary(missing.length, conflicts.length, loops.length, needs.length);
		if (!summary) return;
		const row = activatable(el.createDiv({ cls: "tree-item-self is-clickable relate-issues" }));
		const icon = row.createDiv({ cls: "tree-item-icon" });
		setIcon(icon, "alert-circle");
		row.createDiv({ cls: "tree-item-inner", text: `In this vault: ${summary}` });
		setTooltip(row, "Open Check links");
		row.addEventListener("click", () => new HealthModal(this.plugin).open());
	}

	private sorted(paths: Iterable<string>): string[] {
		return [...paths].sort((a, b) => this.name(a).localeCompare(this.name(b)));
	}

	private namer: (path: string) => string = (p) => p;

	private name(path: string): string {
		return this.namer(path);
	}

	private row(parent: HTMLElement, path: string, file: TFile, prop: string, oneWay: boolean): void {
		const row = activatable(parent.createDiv({ cls: "tree-item-self is-clickable relate-item" + (oneWay ? " is-one-way" : "") }));
		row.createDiv({ cls: "tree-item-inner", text: this.name(path) });
		const flair = row.createDiv({ cls: "tree-item-flair-outer" });

		row.addEventListener("click", (e) => {
			const target = this.app.vault.getAbstractFileByPath(path);
			if (target instanceof TFile) void this.app.workspace.getLeaf(e.metaKey || e.ctrlKey ? "tab" : false).openFile(target);
		});
		row.addEventListener("mouseover", (e) =>
			this.app.workspace.trigger("hover-link", { event: e, source: VIEW_TYPE, hoverParent: this, targetEl: row, linktext: path })
		);

		if (oneWay) {
			flair.createSpan({ cls: "tree-item-flair", text: "not listed here" });
			this.actionIcon(flair, "plus", `List it under ${prop} here too`, () => {
				const target = this.app.vault.getAbstractFileByPath(path);
				const side = this.plugin.sides().get(prop);
				if (target instanceof TFile && side) void this.plugin.sync.fillHere(file, side, path).then((out) => this.plugin.sync.report(out, `Listed ${target.basename} here too.`));
			});
		} else {
			this.actionIcon(
				flair,
				"x",
				`Remove ${this.name(path)} from ${prop} on both notes`,
				() => {
					const side = this.plugin.sides().get(prop);
					if (side) void this.plugin.sync.disconnect(file, side, path).then((out) => this.plugin.sync.report(out, `Removed the link between ${file.basename} and ${this.name(path)}.`));
				},
				"relate-hover-only"
			);
		}
	}
}
