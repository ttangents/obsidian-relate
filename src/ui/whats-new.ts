import { Modal, setIcon, setTooltip } from "obsidian";
import type RelatePlugin from "../main";
import { RELEASE_GROUPS, type ReleaseNote } from "../release-notes";
import { AdoptModal } from "./modals";

/** "Relate works well with Home Cards, my other plugin, which …". The partner is named and linked, never assumed. */
function partnerLine(el: HTMLElement, partner: NonNullable<ReleaseNote["worksWith"]>): void {
	el.appendText("Relate works well with ");
	el.createEl("a", { text: partner.plugin, href: partner.url });
	el.appendText(`, my other plugin, ${partner.about}. You don't need it to use Relate. If you use both:`);
}

/** Shown once, the first time Relate runs in a vault. */
export class WelcomeModal extends Modal {
	constructor(private plugin: RelatePlugin) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal", "relate-welcome-modal");
	}

	onOpen(): void {
		this.titleEl.setText("Welcome to Relate");
		const { contentEl } = this;
		const p = (text: string) => contentEl.createEl("p", { cls: "relate-modal-text", text });
		p("Relate keeps links between notes in step. When one note lists another in a property, such as a project listing its notes, Relate adds the link back on the other note.");
		p("The links are ordinary properties, so the Properties panel, Bases, the graph and backlinks all show them. If you ever remove Relate, every link stays where it is.");
		p("To start, Relate can look for properties in your vault that already link notes, or you can pick a common setup, such as projects and their notes.");
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Not now" }).addEventListener("click", () => this.close());
		const start = footer.createEl("button", { cls: "mod-cta", text: "Find links in your vault" });
		start.addEventListener("click", () => {
			this.close();
			new AdoptModal(this.plugin).open();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The release notes, newest first. `onDone` runs when the window closes, however it closes. */
export class WhatsNewModal extends Modal {
	constructor(plugin: RelatePlugin, private notes: readonly ReleaseNote[], private onDone?: () => void) {
		super(plugin.app);
		this.modalEl.addClass("relate-modal", "relate-whats-new");
	}

	onOpen(): void {
		this.titleEl.setText("What's new in Relate");
		const { contentEl } = this;
		for (const note of this.notes) {
			const release = contentEl.createDiv({ cls: "relate-release" });
			const head = release.createDiv({ cls: "relate-release-head" });
			head.createEl("h3", { text: note.version });
			head.createSpan({ cls: "relate-release-date", text: formatDate(note.date) });
			release.createEl("p", { cls: "relate-release-headline", text: note.headline });
			for (const group of RELEASE_GROUPS) {
				const items = note[group.key];
				if (!items?.length) continue;
				release.createDiv({ cls: "relate-release-group", text: group.label });
				const list = release.createEl("ul");
				for (const item of items) list.createEl("li", { text: item });
			}
			const partner = note.worksWith;
			if (partner?.items.length) {
				release.createDiv({ cls: "relate-release-group", text: `Works with ${partner.plugin}` });
				partnerLine(release.createEl("p", { cls: "relate-release-intro" }), partner);
				const list = release.createEl("ul");
				for (const item of partner.items) list.createEl("li", { text: item });
			}
		}
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		const done = footer.createEl("button", { cls: "mod-cta", text: "Done" });
		done.addEventListener("click", () => this.close());
		window.setTimeout(() => done.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}
}

/** The line at the top of the Connections panel after an update. */
export function renderUpdateNotice(el: HTMLElement, notes: readonly ReleaseNote[], open: () => void, dismiss: () => void): void {
	const newest = notes[0];
	if (!newest) return;
	const box = el.createDiv({ cls: "relate-update", attr: { role: "status" } });
	const text = box.createDiv({ cls: "relate-update-text" });
	text.createDiv({ cls: "relate-update-title", text: `Relate ${newest.version}` });
	text.createDiv({ cls: "relate-update-headline", text: newest.headline });
	const actions = box.createDiv({ cls: "relate-update-actions" });
	actions.createEl("button", { text: "See what's new" }).addEventListener("click", open);
	const close = actions.createEl("button", { cls: "clickable-icon relate-button-reset", attr: { type: "button", "aria-label": "Dismiss" } });
	setIcon(close, "x");
	setTooltip(close, "Dismiss");
	close.addEventListener("click", dismiss);
}

function formatDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}
