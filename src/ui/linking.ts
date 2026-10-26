import { AbstractInputSuggest, App, Menu, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type RelatePlugin from "../main";
import type { Side } from "../settings";
import { NotePickerModal, SidePickerModal } from "./modals";
import { noteNamer, plural } from "../links";

/** Suggests existing folders as you type. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
	}
	getSuggestions(q: string): TFolder[] {
		const query = q.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(query))
			.slice(0, 50);
	}
	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.isRoot() ? "Vault root" : folder.path);
	}
	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.isRoot() ? "" : folder.path);
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

/** The folder most of the notes already listed under `side` live in, or Obsidian's usual folder for new notes. */
function likelyFolder(plugin: RelatePlugin, file: TFile, side: Side): string {
	const counts = new Map<string, number>();
	for (const p of plugin.index.targets(file.path, side.prop)) {
		const folder = p.includes("/") ? p.replace(/\/[^/]*$/, "") : "";
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
	const best = [...counts].sort((a, b) => b[1] - a[1])[0];
	if (best) return best[0];
	const parent = plugin.app.fileManager.getNewFileParent(file.path);
	return parent.isRoot() ? "" : parent.path;
}

/** Creates a note that is already linked to `file`, on both sides. */
export class NewLinkedNoteModal extends Modal {
	private title = "";
	private folder = "";
	private openAfter = true;

	constructor(private plugin: RelatePlugin, private file: TFile, private side: Side) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal");
		this.folder = likelyFolder(plugin, file, side);
	}

	onOpen(): void {
		const { contentEl } = this;
		const { side, file } = this;
		this.titleEl.setText(`New note under ${side.prop}`);
		contentEl.createDiv({
			cls: "relate-modal-text",
			text:
				side.prop === side.inverse
					? `Relate creates the note, and both notes list each other under “${side.prop}”.`
					: `Relate creates the note, lists it under “${side.prop}” on ${file.basename}, and lists ${file.basename} under “${side.inverse}” on the new note.`,
		});
		let createBtn: HTMLButtonElement;
		new Setting(contentEl).setName("Title").addText((t) => {
			t.setPlaceholder("Untitled").onChange((v) => {
				this.title = v;
				createBtn.disabled = !v.trim();
			});
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && this.title.trim()) {
					e.preventDefault();
					void this.create();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Where the new note goes. Leave empty for the vault root.")
			.addText((t) => {
				t.setValue(this.folder).onChange((v) => (this.folder = v.trim()));
				new FolderSuggest(this.app, t.inputEl);
			});
		new Setting(contentEl).setName("Open the new note").addToggle((t) => t.setValue(this.openAfter).onChange((v) => (this.openAfter = v)));
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		createBtn = footer.createEl("button", { cls: "mod-cta", text: "Create" });
		createBtn.disabled = true;
		createBtn.addEventListener("click", () => void this.create());
	}

	private async create(): Promise<void> {
		const clean = this.title.trim().replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
		if (!clean) return;
		const path = normalizePath(`${this.folder ? this.folder + "/" : ""}${clean}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(`A note named “${clean}” already exists in that folder. Choose another title, or link the existing note instead.`, 8000);
			return;
		}
		this.close();
		try {
			if (this.folder && !this.app.vault.getAbstractFileByPath(normalizePath(this.folder))) await this.app.vault.createFolder(normalizePath(this.folder));
			const note = await this.app.vault.create(path, "");
			const out = await this.plugin.sync.connect(this.file, this.side, note);
			this.plugin.sync.report(out, `Created ${note.basename} and linked it to ${this.file.basename}.`);
			if (this.openAfter) await this.app.workspace.getLeaf("tab").openFile(note);
		} catch (e) {
			const msg = this.plugin.reportError("Creating a linked note", e);
			new Notice(`Relate could not create the note: ${msg}`, 10000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Links several notes in one step. Either several notes to one note (from a note), or one note to
 * several selected files (from the file explorer). Shows what will change before it changes anything.
 */
export class LinkManyModal extends Modal {
	private chosen = new Set<string>();
	private filter = "";
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private applyBtn!: HTMLButtonElement;

	constructor(private plugin: RelatePlugin, private file: TFile, private side: Side) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal", "relate-link-many");
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Link notes under ${this.side.prop}`);
		contentEl.createDiv({ cls: "relate-modal-text", text: `Choose the notes ${this.file.basename} should list under “${this.side.prop}”. Each of them will list ${this.file.basename} back.` });
		const search = contentEl.createEl("input", { type: "search", cls: "relate-link-many-filter", attr: { placeholder: "Filter notes by title or folder", "aria-label": "Filter notes" } });
		search.addEventListener("input", () => {
			this.filter = search.value.trim().toLowerCase();
			this.renderList();
		});
		window.setTimeout(() => search.focus(), 0);
		this.listEl = contentEl.createDiv({ cls: "relate-rows relate-link-many-list", attr: { role: "group", "aria-label": "Notes" } });
		this.summaryEl = contentEl.createDiv({ cls: "relate-modal-text relate-preview" });
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.applyBtn = footer.createEl("button", { cls: "mod-cta", text: "Link" });
		this.applyBtn.addEventListener("click", () => void this.apply());
		this.renderList();
		this.renderSummary();
	}

	private candidates(): TFile[] {
		const already = this.plugin.index.targets(this.file.path, this.side.prop);
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f !== this.file && !already.has(f.path))
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	private renderList(): void {
		this.listEl.empty();
		const name = noteNamer(this.app.vault.getMarkdownFiles().map((f) => f.path));
		const all = this.candidates().filter((f) => !this.filter || f.path.toLowerCase().includes(this.filter));
		for (const f of all.slice(0, 200)) {
			const row = this.listEl.createEl("label", { cls: "relate-row relate-check-row" });
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = this.chosen.has(f.path);
			box.addEventListener("change", () => {
				if (box.checked) this.chosen.add(f.path);
				else this.chosen.delete(f.path);
				this.renderSummary();
			});
			row.createSpan({ text: name(f.path) });
			if (f.parent && !f.parent.isRoot()) row.createSpan({ cls: "relate-muted", text: f.parent.path });
		}
		if (all.length > 200) this.listEl.createDiv({ cls: "relate-row relate-muted", text: `${all.length - 200} more. Type to narrow the list.` });
		if (!all.length) this.listEl.createDiv({ cls: "relate-row relate-muted", text: "No notes match." });
	}

	private renderSummary(): void {
		const n = this.chosen.size;
		this.applyBtn.disabled = n === 0;
		this.applyBtn.setText(n ? `Link ${plural(n, "note", "notes")}` : "Link");
		this.summaryEl.setText(
			n
				? `${this.file.basename} will list ${plural(n, "note", "notes")} under “${this.side.prop}”, and each will list ${this.file.basename} under “${this.side.inverse}”. One Undo reverses it all.${this.side.inverseOne ? ` A note that already has a ${this.side.inverse} moves to ${this.file.basename}.` : ""}`
				: "No notes chosen yet."
		);
	}

	private async apply(): Promise<void> {
		const targets = [...this.chosen].map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile);
		this.close();
		const out = await this.plugin.sync.connectMany(
			targets.map((target) => ({ file: this.file, side: this.side, target })),
			`Linked ${plural(targets.length, "note", "notes")} to ${this.file.basename}`
		);
		this.plugin.sync.report(out, `Linked ${plural(targets.length - out.skipped.length, "note", "notes")} to ${this.file.basename}.`);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Links each of several files to one chosen note, from a multi-selection in the file explorer or from search
 * results. `after` runs once the links are written, with every note that changed.
 */
export function linkSelected(plugin: RelatePlugin, files: TFile[], after?: (changed: string[]) => void): void {
	const notes = files.filter((f) => f.extension === "md");
	if (!notes.length) return;
	new SidePickerModal(plugin, notes[0], (side) => {
		new NotePickerModal(plugin.app, notes[0], `Choose the note ${plural(notes.length, "note", "notes")} should list under ${side.prop}`, (target) => void (async () => {
			const pairs = notes.filter((f) => f !== target).map((file) => ({ file, side, target }));
			const out = await plugin.sync.connectMany(pairs, `Linked ${plural(pairs.length, "note", "notes")} to ${target.basename}`);
			plugin.sync.report(out, `Linked ${plural(pairs.length, "note", "notes")} to ${target.basename}.`);
			after?.([...new Set(out.applied.map((op) => op.path))]);
		})()).open();
	}, `Choose how to link ${plural(notes.length, "note", "notes")}`).open();
}

/** The three ways to link from a note: an existing note, a new note, or several notes. */
export function linkMenu(plugin: RelatePlugin, file: TFile, evt: MouseEvent | KeyboardEvent, side?: Side): void {
	const withSide = (fn: (s: Side) => void) => {
		if (side) fn(side);
		else if (!plugin.sides().size) plugin.openSettings();
		else new SidePickerModal(plugin, file, fn).open();
	};
	const menu = new Menu();
	menu.addItem((i) =>
		i
			.setTitle("Link an existing note…")
			.setIcon("link")
			.onClick(() => withSide((s) => new NotePickerModal(plugin.app, file, `Choose a note to list under ${s.prop}`, (t) => void plugin.connect(file, s, t)).open()))
	);
	menu.addItem((i) => i.setTitle("Create a new linked note…").setIcon("file-plus").onClick(() => withSide((s) => new NewLinkedNoteModal(plugin, file, s).open())));
	menu.addItem((i) => i.setTitle("Link several notes…").setIcon("list-plus").onClick(() => withSide((s) => new LinkManyModal(plugin, file, s).open())));
	if (evt instanceof MouseEvent) menu.showAtMouseEvent(evt);
	else {
		const r = (evt.target as HTMLElement).getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom });
	}
}

/** Search results with a box each, all ticked, so the reader can leave some out before linking the rest. */
export class LinkResultsModal extends Modal {
	private chosen: Set<string>;
	private button!: HTMLButtonElement;

	constructor(private plugin: RelatePlugin, private files: TFile[], private after?: (changed: string[]) => void) {
		super(plugin.app);
		this.chosen = new Set(files.map((f) => f.path));
		this.modalEl.addClass("relate-modal", "relate-link-many");
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Link these notes");
		contentEl.createDiv({
			cls: "relate-modal-text",
			text: "Untick any note you want to leave out. Next, choose the relationship and the note to link them to. One undo reverses the whole batch.",
		});
		const name = noteNamer(this.app.vault.getMarkdownFiles().map((f) => f.path));
		const list = contentEl.createDiv({ cls: "relate-rows relate-link-many-list", attr: { role: "group", "aria-label": "Notes" } });
		for (const f of this.files) {
			const row = list.createEl("label", { cls: "relate-row relate-check-row" });
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = true;
			box.addEventListener("change", () => {
				if (box.checked) this.chosen.add(f.path);
				else this.chosen.delete(f.path);
				this.update();
			});
			row.createSpan({ text: name(f.path) });
			if (f.parent && !f.parent.isRoot()) row.createSpan({ cls: "relate-muted", text: f.parent.path });
		}
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.button = footer.createEl("button", { cls: "mod-cta" });
		this.button.addEventListener("click", () => {
			const files = this.files.filter((f) => this.chosen.has(f.path));
			this.close();
			linkSelected(this.plugin, files, this.after);
		});
		this.update();
	}

	private update(): void {
		const n = this.chosen.size;
		this.button.setText(n ? `Link ${plural(n, "note", "notes")}…` : "Link");
		this.button.disabled = n === 0;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
