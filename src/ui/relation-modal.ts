import { Modal, Setting } from "obsidian";
import type RelatePlugin from "../main";
import { validateRelations, type Relation } from "../settings";

/**
 * Edits one relationship as a draft. Nothing reaches the settings, or any note, until Save, and Save waits until
 * the relationship is valid, so a half-typed property name never starts linking notes.
 */
export class RelationModal extends Modal {
	private draft: Relation;
	private problemsEl!: HTMLElement;
	private saveButton!: HTMLButtonElement;

	/** `index` is the relationship to edit, or null for a new one. */
	constructor(
		private plugin: RelatePlugin,
		private index: number | null,
		private onSaved: () => void
	) {
		super(plugin.app);
		const current = index === null ? undefined : plugin.settings.relations[index];
		this.draft = current ? { ...current } : { property: "", inverse: "", propertyOne: false, inverseOne: false, chains: false };
		this.modalEl.addClass("relate-modal");
	}

	onOpen(): void {
		this.titleEl.setText(this.index === null ? "New relationship" : "Edit relationship");
		this.draw();
	}

	private draw(): void {
		const { contentEl } = this;
		const r = this.draft;
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "relate-modal-text",
			text: "A relationship pairs two properties. When a note lists another note in the first, Relate lists it back in the second.",
		});
		const same = () => r.property !== "" && r.property === r.inverse;
		let oneFirst: Setting;
		let oneSecond: Setting;
		let rule: Setting | undefined;
		const relabel = () => {
			rule?.setName(r.property ? `Notes that need a link in ${r.property}` : "Notes that need a link");
			oneFirst.setName(r.property ? `Only one ${r.property} per note` : "Only one per note");
			oneSecond.setName(r.inverse ? `Only one ${r.inverse} per note` : "Only one per note");
			oneSecond.settingEl.toggle(!same());
			this.check();
		};
		new Setting(contentEl)
			.setName("Property")
			.setDesc("The property you fill in, such as “parent” or “project”.")
			.addText((t) =>
				t.setValue(r.property).onChange((v) => {
					r.property = v.trim();
					if (same()) r.inverseOne = r.propertyOne;
					relabel();
				})
			);
		new Setting(contentEl)
			.setName("Property on the other note")
			.setDesc("Relate fills this one in, such as “children” or “notes”. Use the same name when the link reads the same both ways, such as “related”.")
			.addText((t) =>
				t.setValue(r.inverse).onChange((v) => {
					r.inverse = v.trim();
					if (same()) r.inverseOne = r.propertyOne;
					relabel();
				})
			);
		oneFirst = new Setting(contentEl).addToggle((t) =>
			t.setValue(r.propertyOne).onChange((v) => {
				r.propertyOne = v;
				if (same()) r.inverseOne = v;
			})
		);
		oneSecond = new Setting(contentEl).addToggle((t) => t.setValue(r.inverseOne).onChange((v) => (r.inverseOne = v)));
		rule = new Setting(contentEl)
			.setDesc("Optional. A folder path, or a tag such as “#paper”. Check links lists the notes there that have none.")
			.addText((t) => t.setValue(r.required ?? "").onChange((v) => (r.required = v.trim())));
		new Setting(contentEl)
			.setName("Follow chains in search")
			.setDesc("A search for “all children of …” then also finds their children, and so on.")
			.addToggle((t) => t.setValue(r.chains).onChange((v) => (r.chains = v)));

		this.problemsEl = contentEl.createDiv({ cls: "relate-problems" });
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.saveButton = footer.createEl("button", { cls: "mod-cta", text: "Save" });
		this.saveButton.addEventListener("click", () => void this.save());
		relabel();
	}

	/** The relationships as they would be after saving. */
	private result(): Relation[] {
		const list = [...this.plugin.settings.relations];
		if (this.index === null) list.push(this.draft);
		else list[this.index] = this.draft;
		return list;
	}

	/** Shows what stops the relationship from being saved, and enables Save when nothing does. */
	private check(): string[] {
		const problems = !this.draft.property || !this.draft.inverse ? ["Fill in both property names."] : validateRelations(this.result());
		this.problemsEl.empty();
		for (const p of problems) this.problemsEl.createDiv({ text: p });
		this.saveButton.disabled = problems.length > 0;
		return problems;
	}

	private async save(): Promise<void> {
		if (this.check().length) return;
		this.plugin.settings.relations = this.result();
		await this.plugin.saveSettings();
		this.plugin.relationsChanged();
		this.close();
		this.onSaved();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
