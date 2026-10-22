import { Modal } from "obsidian";
import type RelatePlugin from "../main";
import { BUILTIN } from "../semantic/embedders";

/** Asks before Relate downloads the language model to this device. */
export class ConsentModal extends Modal {
	private answered = false;

	constructor(private plugin: RelatePlugin, private onYes: () => Promise<void>, private onCancel?: () => void) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal");
	}

	onOpen(): void {
		this.titleEl.setText("Turn on search by meaning");
		const { contentEl } = this;
		contentEl.createDiv({
			cls: "relate-modal-text",
			text: "Search by meaning finds notes about an idea even when they use different words, and shows similar notes in the Connections panel.",
		});
		const list = contentEl.createEl("ul", { cls: "relate-modal-text relate-consent-list" });
		list.createEl("li", { text: `Relate downloads one small language model, ${BUILTIN.name} (${BUILTIN.sizeLabel}, ${BUILTIN.license} license), from Hugging Face. This happens once on each device.` });
		list.createEl("li", { text: "The model and the index stay on this device, outside your vault, so sync does not copy them." });
		list.createEl("li", { text: "Relate reads your notes on this device only. Your notes are not sent anywhere." });
		list.createEl("li", { text: "You can remove the model and the index at any time in Relate's settings." });
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const yes = footer.createEl("button", { cls: "mod-cta", text: `Download (${BUILTIN.sizeLabel})` });
		yes.addEventListener("click", () => {
			this.answered = true;
			this.close();
			void this.onYes();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.onCancel?.();
	}
}
