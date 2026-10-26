import { App, FuzzySuggestModal, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import type RelatePlugin from "../main";
import type { Side } from "../settings";
import { availablePresets, type Relation } from "../settings";
import type { Need } from "../health";
import { previewRelations, scanProperties, type PropertyUse } from "../adopt";
import type { Conflict, Health, Loop, Missing } from "../sync";
import { noteNamer } from "../links";

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

let noteName = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/, "");

/** Joins names as "A", "A and B", or "A, B and C". */
function joinNames(names: string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Step 1 of linking: choose the kind of link. */
export class SidePickerModal extends SuggestModal<Side> {
	constructor(private plugin: RelatePlugin, private file: TFile, private done: (side: Side) => void, placeholder?: string) {
		super(plugin.app);
		this.setPlaceholder(placeholder ?? `Choose how to link ${file.basename}`);
		this.emptyStateText = "No relationship matches what you typed.";
	}
	getSuggestions(q: string): Side[] {
		const query = q.toLowerCase();
		return [...this.plugin.sides().values()].filter((s) => s.prop.toLowerCase().includes(query));
	}
	renderSuggestion(side: Side, el: HTMLElement): void {
		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({ cls: "suggestion-title", text: side.prop });
		const note =
			side.prop === side.inverse
				? `Both notes list each other under “${side.prop}”.`
				: `${this.file.basename} lists the note under “${side.prop}”, and the note lists ${this.file.basename} under “${side.inverse}”.`;
		content.createDiv({ cls: "suggestion-note", text: note });
	}
	onChooseSuggestion(side: Side): void {
		this.done(side);
	}
}

/** Step 2: choose the note. */
export class NotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private exclude: TFile, placeholder: string, private done: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => f !== this.exclude);
	}
	getItemText(f: TFile): string {
		return f.path.replace(/\.md$/, "");
	}
	onChooseItem(f: TFile): void {
		this.done(f);
	}
}

export function linkAs(plugin: RelatePlugin, file: TFile, side?: Side): void {
	const pickNote = (s: Side) =>
		new NotePickerModal(plugin.app, file, `Choose a note to list under ${s.prop}`, (target) => void plugin.connect(file, s, target)).open();
	if (side) pickNote(side);
	else if (!plugin.sides().size) plugin.openSettings();
	else new SidePickerModal(plugin, file, pickNote).open();
}

/** A property the scan found, and whether the user turned it on. */
interface Candidate extends PropertyUse {
	chosen: boolean;
}

/** Finds properties that already link notes and offers to turn them into relationships. */
export class AdoptModal extends Modal {
	private candidates: Candidate[] = [];
	/** Properties left out of the list: used in only one note, or beyond the first fifteen. */
	private hiddenRare = 0;
	private hiddenMore = 0;
	private previewEl!: HTMLElement;
	private applyBtn!: HTMLButtonElement;
	private previewTimer: number | null = null;

	constructor(private plugin: RelatePlugin) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal");
	}

	/** Properties whose values link to other notes, from the domain scan. */
	private scan(): Candidate[] {
		const found = scanProperties(this.app, new Set(this.plugin.sides().keys()));
		this.hiddenRare = found.hiddenRare;
		this.hiddenMore = found.hiddenMore;
		return found.candidates.map((c) => ({ ...c, chosen: false }));
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Find links in your vault");
		this.candidates = this.scan();
		if (!this.candidates.length) {
			contentEl.createDiv({
				cls: "relate-modal-text",
				text: this.hiddenRare
					? "Only single notes use properties that link to other notes, so none of them looks like a relationship yet. You can set one up by hand in Relate's settings."
					: "None of your note properties link to other notes yet. You can set up a relationship by hand in Relate's settings.",
			});
			this.renderPresets(contentEl, "Start from a common setup");
			return;
		}
		contentEl.createDiv({
			cls: "relate-modal-text",
			text: "These properties already link notes together. Turn on each one that describes a relationship, then name what the other note should call it.",
		});
		const left: string[] = [];
		if (this.hiddenMore) left.push(`${plural(this.hiddenMore, "less-used property", "less-used properties")}`);
		if (this.hiddenRare) left.push(`${plural(this.hiddenRare, "property", "properties")} used in only one note`);
		if (left.length)
			contentEl.createDiv({
				cls: "relate-modal-text",
				text: `This list shows the properties used most. It leaves out ${left.join(" and ")}. You can add any property by hand in Relate's settings.`,
			});
		const list = contentEl.createDiv({ cls: "relate-candidates" });
		for (const c of this.candidates) this.row(list, c);

		this.previewEl = contentEl.createDiv({ cls: "relate-modal-text relate-preview" });
		this.renderPresets(contentEl, "Or start from a common setup");
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		this.applyBtn = footer.createEl("button", { cls: "mod-cta", text: "Connect" });
		this.applyBtn.addEventListener("click", () => void this.apply());
		this.updatePreview();
	}

	private row(parent: HTMLElement, c: Candidate): void {
		const box = parent.createDiv({ cls: "relate-candidate" });
		const detail = createDiv({ cls: "relate-candidate-detail" });
		detail.hide();
		new Setting(box)
			.setName(c.prop)
			.setDesc(`${plural(c.links, "link", "links")} in ${plural(c.notes, "note", "notes")}`)
			.addToggle((t) =>
				t.setValue(c.chosen).onChange((v) => {
					c.chosen = v;
					detail.toggle(v);
					this.schedulePreview();
				})
			);
		box.appendChild(detail);
		new Setting(detail)
			.setName("The other note calls it")
			.setDesc(`Use “${c.prop}” if both notes should list each other the same way.`)
			.addText((t) =>
				t.setValue(c.relation.inverse).onChange((v) => {
					c.relation.inverse = v.trim();
					this.schedulePreview();
				})
			);
		new Setting(detail)
			.setName(`Only one ${c.prop} per note`)
			.addToggle((t) => t.setValue(c.relation.propertyOne).onChange((v) => (c.relation.propertyOne = v)));
	}

	/** Common setups the user can add in one click. Adding one changes no notes. */
	private renderPresets(el: HTMLElement, heading: string): void {
		const box = el.createDiv({ cls: "relate-presets" });
		const draw = () => {
			box.empty();
			const presets = availablePresets(this.plugin.settings.relations);
			if (!presets.length) return;
			new Setting(box).setName(heading).setDesc("Adding one changes no notes. It tells Relate how to keep those properties in step from now on.").setHeading();
			for (const p of presets) {
				new Setting(box)
					.setName(p.name)
					.setDesc(p.description)
					.addButton((b) =>
						b.setButtonText("Add").onClick(async () => {
							const problems = this.plugin.addRelations([{ ...p.relation }]);
							if (problems.length) {
								new Notice(problems[0], 8000);
								return;
							}
							await this.plugin.saveSettings();
							this.plugin.relationsChanged();
							new Notice(`Added “${p.name}”. Link notes from the Connections panel, or type the property in a note.`);
							draw();
						})
					);
			}
		};
		draw();
	}

	private chosen(): Relation[] {
		return this.candidates.filter((c) => c.chosen && c.relation.inverse).map((c) => c.relation);
	}

	private schedulePreview(): void {
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = window.setTimeout(() => this.updatePreview(), 200);
	}

	private updatePreview(): void {
		const rels = this.chosen();
		if (!rels.length) {
			this.previewEl.setText("Turn on at least one property to continue.");
			this.applyBtn.disabled = true;
			return;
		}
		const { links, notes, choices } = previewRelations(this.app, rels);
		this.applyBtn.disabled = false;
		const parts = [
			links
				? `Relate will add ${plural(links, "link", "links")} to ${plural(notes, "note", "notes")}. It changes only properties, and you can undo it in settings.`
				: "Both sides are already in place. Relate will keep them that way from now on.",
		];
		if (choices) parts.push(`${plural(choices, "note", "notes")} will need your choice afterwards, because more than one note claims a property that holds only one link. Relate leaves those alone.`);
		this.previewEl.setText(parts.join(" "));
	}

	private async apply(): Promise<void> {
		const rels = this.chosen();
		const problems = this.plugin.addRelations(rels);
		if (problems.length) {
			new Notice(problems[0], 8000);
			return;
		}
		this.close();
		await this.plugin.saveSettings();
		this.plugin.relationsChanged();
		const only = new Set(rels.flatMap((r) => [r.property, r.inverse]));
		const { missing, conflicts } = this.plugin.sync.health(only);
		const out = await this.plugin.sync.repair(missing, `Connected ${joinNames(rels.map((r) => r.property))}`);
		if (out.error) {
			this.plugin.sync.report(out, "");
		} else {
			new Notice(
				`Relate added ${plural(out.applied.length, "link", "links")}.` +
					(out.skipped.length ? ` It skipped ${out.skipped.length} because the notes changed meanwhile.` : "") +
					(conflicts.length ? ` ${plural(conflicts.length, "note needs", "notes need")} your choice. Open Check links to decide.` : ""),
				8000
			);
		}
		void this.plugin.activateView();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Lists one-way links and competing claims, and fixes them on request. */
export class HealthModal extends Modal {
	constructor(private plugin: RelatePlugin) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal");
	}

	onOpen(): void {
		this.titleEl.setText("Check links");
		this.render(this.plugin.sync.health());
	}

	private render(h: Health): void {
		noteName = noteNamer(this.app.vault.getMarkdownFiles().map((f) => f.path));
		const { contentEl } = this;
		contentEl.empty();
		if (!h.missing.length && !h.conflicts.length && !h.loops.length && !h.needs.length) {
			contentEl.createDiv({ cls: "relate-modal-text", text: "Every link is recorded on both notes, and every note has the links its rules ask for. There is nothing to fix." });
			return;
		}
		if (h.loops.length) this.renderLoops(contentEl, h.loops);
		if (h.missing.length) this.renderMissing(contentEl, h.missing);
		if (h.conflicts.length) this.renderConflicts(contentEl, h.conflicts);
		if (h.needs.length) this.renderNeeds(contentEl, h.needs);
	}

	private renderLoops(el: HTMLElement, loops: Loop[]): void {
		new Setting(el).setName(loops.length === 1 ? "A loop" : "Loops").setHeading();
		el.createDiv({
			cls: "relate-modal-text",
			text: "Following these links upwards leads back to where it started, so a note ends up inside itself. Remove one link in each loop. Relate does not choose which, because only you know which link is wrong.",
		});
		const list = el.createDiv({ cls: "relate-rows" });
		for (const loop of loops.slice(0, 50)) {
			const row = list.createDiv({ cls: "relate-row" });
			row.createEl("code", { text: loop.prop });
			row.appendText(": ");
			loop.path.forEach((p, i) => {
				if (i) row.appendText(" → ");
				this.link(row, p);
			});
		}
	}

	private renderMissing(el: HTMLElement, missing: Missing[]): void {
		new Setting(el)
			.setName("One-way links")
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(missing.length === 1 ? "Add it" : `Add all ${missing.length}`)
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						const out = await this.plugin.sync.repair(missing);
						if (out.error) this.plugin.sync.report(out, "");
						else if (out.skipped.length)
							new Notice(`Relate added ${plural(out.applied.length, "link", "links")} and skipped ${out.skipped.length}: ${out.skipped.slice(0, 3).join(" ")}${out.skipped.length > 3 ? " …" : ""}`, 10000);
						else new Notice(`Relate added ${plural(out.applied.length, "link", "links")}.`);
						this.refresh();
					})
			);
		el.createDiv({
			cls: "relate-modal-text",
			text: "One note lists the other, but the other does not list it back. Relate can add the missing side. It never removes links here.",
		});
		const list = el.createDiv({ cls: "relate-rows" });
		for (const m of missing.slice(0, 100)) {
			const row = list.createDiv({ cls: "relate-row" });
			row.appendText("Add ");
			this.link(row, m.target);
			row.appendText(` to ${noteName(m.file)}'s `);
			row.createEl("code", { text: m.prop });
		}
		if (missing.length > 100) list.createDiv({ cls: "relate-row relate-muted", text: `${missing.length - 100} more not shown.` });
	}

	/** Notes a rule says need a link, each with a button to link it. */
	private renderNeeds(el: HTMLElement, needs: Need[]): void {
		new Setting(el).setName(needs.length === 1 ? "A note that needs a link" : "Notes that need a link").setHeading();
		el.createDiv({
			cls: "relate-modal-text",
			text: "Your relationship settings say these notes should have a link, and they have none. Link each one, or change the rule in Relate's settings.",
		});
		const list = el.createDiv({ cls: "relate-rows" });
		for (const n of needs.slice(0, 100)) {
			const row = list.createDiv({ cls: "relate-row relate-conflict" });
			const line = row.createDiv();
			this.link(line, n.file);
			line.appendText(` has no ${n.prop}. Rule: notes ${n.scope.startsWith("#") ? "tagged" : "in"} ${n.scope} need one.`);
			const side = this.plugin.sides().get(n.prop);
			const file = this.app.vault.getAbstractFileByPath(n.file);
			if (!side || !(file instanceof TFile)) continue;
			const buttons = row.createDiv({ cls: "relate-choices" });
			buttons.createEl("button", { text: `Choose ${n.prop}…` }).addEventListener("click", () => {
				new NotePickerModal(this.app, file, `Choose ${file.basename}'s ${n.prop}`, (target) => {
					void this.plugin.connect(file, side, target).then(() => this.refresh());
				}).open();
			});
		}
		if (needs.length > 100) list.createDiv({ cls: "relate-row relate-muted", text: `${needs.length - 100} more not shown.` });
	}

	private renderConflicts(el: HTMLElement, conflicts: Conflict[]): void {
		new Setting(el).setName(conflicts.length === 1 ? "A choice to make" : "Choices to make").setHeading();
		el.createDiv({
			cls: "relate-modal-text",
			text: "Each of these notes can have only one link in a property, but more than one note claims the spot. Choose the note to keep. Relate removes the link from the others. You can undo this in settings.",
		});
		const list = el.createDiv({ cls: "relate-rows" });
		for (const c of conflicts.slice(0, 50)) {
			const row = list.createDiv({ cls: "relate-row relate-conflict" });
			const line = row.createDiv();
			this.link(line, c.file);
			const claimants = joinNames(c.claimants.map(noteName));
			const current = joinNames(c.current.map(noteName));
			if (c.current.length > 1 && !c.claimants.length) {
				line.appendText(` lists more than one ${c.prop}: ${current}.`);
			} else if (c.current.length > 1) {
				line.appendText(` lists more than one ${c.prop}: ${current}. ${claimants} also ${c.claimants.length === 1 ? "lists" : "list"} it under ${c.via}.`);
			} else if (c.current.length) {
				line.appendText(` has ${c.prop} ${current}, but ${claimants} also ${c.claimants.length === 1 ? "lists" : "list"} it under ${c.via}.`);
			} else {
				line.appendText(` has no ${c.prop}. ${claimants} ${c.claimants.length === 2 ? "both list" : "list"} it under ${c.via}.`);
			}
			const buttons = row.createDiv({ cls: "relate-choices" });
			for (const p of [...c.current, ...c.claimants]) {
				const b = buttons.createEl("button", { text: `Keep ${noteName(p)}` });
				b.addEventListener("click", () => void (async () => {
					buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
					const out = await this.plugin.sync.resolve(c, p);
					if (out.error && out.applied.length) this.plugin.sync.report(out, "");
					else if (out.error) new Notice(`Relate did not change anything: ${out.error}`, 10000);
					else new Notice(`${noteName(c.file)}'s ${c.prop} is now ${noteName(p)}.`);
					this.refresh();
				})());
			}
		}
	}

	/** Re-checks once Obsidian has re-read the notes Relate just changed. */
	private refresh(): void {
		window.setTimeout(() => {
			const h = this.plugin.sync.health();
			if (!h.missing.length && !h.conflicts.length && !h.loops.length) {
				this.close();
				new Notice("Every link is now recorded on both notes.");
			} else {
				this.render(h);
			}
		}, 800);
	}

	private link(parent: HTMLElement, path: string): void {
		const a = parent.createEl("a", { text: noteName(path), href: "#", cls: "internal-link" });
		a.addEventListener("click", (e) => {
			e.preventDefault();
			void this.app.workspace.openLinkText(path, "", false);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
