import { Modal } from "obsidian";
import type RelatePlugin from "../main";
import { BUILTIN } from "../semantic/embedders";
import { INSECURE_WARNING, insecureRemote } from "../semantic/consent";

/** Asks before Relate downloads the language model to this device. */
export class ConsentModal extends Modal {
	private answered = false;

	/** `temporary` says the device cannot keep the model, so this download lasts for this session only. */
	constructor(plugin: RelatePlugin, private onYes: () => Promise<void>, private onCancel?: () => void, private temporary = false) {
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
		list.createEl("li", {
			text: this.temporary
				? `Relate downloads one small language model, ${BUILTIN.name} (${BUILTIN.sizeLabel}, ${BUILTIN.license} license), from Hugging Face. This device's browser storage is not available, so the model lasts until Obsidian closes, and Relate asks again next time.`
				: `Relate downloads one small language model, ${BUILTIN.name} (${BUILTIN.sizeLabel}, ${BUILTIN.license} license), from Hugging Face. This happens once on each device.`,
		});
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

/** Asks before Relate sends the text of notes to a server, naming the exact address. */
export class ServerConsentModal extends Modal {
	private answered = false;

	constructor(plugin: RelatePlugin, private url: string, private onYes: () => Promise<void>, private onCancel?: () => void) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal");
	}

	onOpen(): void {
		this.titleEl.setText("Send notes to your server?");
		const { contentEl } = this;
		const intro = contentEl.createDiv({ cls: "relate-modal-text" });
		intro.appendText("Search by meaning on this device sends the text of your notes, and what you type in search, to ");
		intro.createEl("code", { text: this.url });
		intro.appendText(". That server turns them into numbers Relate can compare.");
		const list = contentEl.createEl("ul", { cls: "relate-modal-text relate-consent-list" });
		list.createEl("li", { text: "Relate sends note text to this address only, and only from this device. Each device asks for itself." });
		list.createEl("li", { text: "If you change the address, Relate asks again before it sends anything." });
		list.createEl("li", { text: "You can turn search by meaning off at any time in Relate's settings." });
		if (insecureRemote(this.url)) contentEl.createDiv({ cls: "relate-modal-text relate-warning", text: INSECURE_WARNING });
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const yes = footer.createEl("button", { cls: "mod-cta", text: "Send notes to this server" });
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
