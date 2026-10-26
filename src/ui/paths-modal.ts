import { Keymap, Modal, Setting, TFile } from "obsidian";
import type RelatePlugin from "../main";
import { BUSY_NOTE, findPaths, type Step } from "../paths";
import { NotePickerModal } from "./modals";
import { basename } from "../links";


/** Shows the short chains of relationships that join two notes. */
class PathsModal extends Modal {
	private prop = "";
	private skipBusy = true;
	private listEl!: HTMLElement;

	constructor(private plugin: RelatePlugin, private from: TFile, private to: TFile) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("relate-paths-modal");
		this.titleEl.setText(`How ${this.from.basename} and ${this.to.basename} are connected`);
		new Setting(this.contentEl)
			.setName("Relationship")
			.setDesc("Follow every relationship, or only one.")
			.addDropdown((d) => {
				d.addOption("", "Any relationship");
				for (const side of this.plugin.sides().values()) d.addOption(side.prop, side.prop);
				d.setValue(this.prop).onChange((v) => {
					this.prop = v;
					this.draw();
				});
			});
		new Setting(this.contentEl)
			.setName("Skip busy notes")
			.setDesc(`Do not pass through notes with more than ${BUSY_NOTE} connections, such as an index or a hub.`)
			.addToggle((t) =>
				t.setValue(this.skipBusy).onChange((v) => {
					this.skipBusy = v;
					this.draw();
				})
			);
		this.listEl = this.contentEl.createDiv({ cls: "relate-paths-list" });
		this.draw();
	}

	private draw(): void {
		this.listEl.empty();
		const sides = this.plugin.sides();
		const props = this.prop ? new Set([this.prop, sides.get(this.prop)?.inverse ?? this.prop]) : undefined;
		const paths = findPaths(this.plugin.index, sides, this.from.path, this.to.path, {
			props,
			maxSteps: 6,
			limit: 5,
			busy: this.skipBusy ? BUSY_NOTE : null,
		});
		if (!paths.length) {
			this.listEl.createDiv({
				cls: "relate-empty",
				text: this.skipBusy
					? "No chain of up to six links joins these notes. Turn off Skip busy notes to look through hub notes too."
					: "No chain of up to six links joins these notes.",
			});
			return;
		}
		for (const path of paths) renderPath(this.listEl.createDiv({ cls: "relate-paths-row" }), this.plugin, path, () => this.close());
	}
}

/** Draws "A → home: B → region: C", with each note clickable. */
function renderPath(el: HTMLElement, plugin: RelatePlugin, path: Step[], after?: () => void): void {
	el.addClass("relate-path");
	const note = (p: string) => {
		const a = el.createEl("a", { cls: "relate-path-note internal-link", text: basename(p), href: "#" });
		a.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const f = plugin.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) void plugin.app.workspace.getLeaf(Keymap.isModEvent(e) ? "tab" : false).openFile(f);
			after?.();
		});
	};
	note(path[0].from);
	for (const step of path) {
		el.createSpan({ cls: "relate-path-prop", text: ` → ${step.prop}: ` });
		note(step.to);
	}
}

/** Asks for the second note, then shows the paths. */
export function showPaths(plugin: RelatePlugin, from: TFile): void {
	new NotePickerModal(plugin.app, from, `How is ${from.basename} connected to…`, (to) => new PathsModal(plugin, from, to).open()).open();
}
