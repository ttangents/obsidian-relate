import { Keymap, Menu, Platform, SuggestModal, TFile, setIcon } from "obsidian";
import type RelatePlugin from "../main";
import { chipToText, removeChip, replaceChip, type Chip } from "../search/parser";
import type { SearchResult } from "../search/service";

function chipText(chip: Chip): string {
	if (chip.kind === "relation") return chip.chain.map((c) => `${c.all ? "all " : ""}${c.label} of `).join("") + chip.note.title;
	if (chip.kind === "connected") return `connected to ${chip.note.title}`;
	return chip.label;
}

export class SearchModal extends SuggestModal<SearchResult> {
	private chipsEl: HTMLElement;
	private lastQuery = "";

	constructor(private plugin: RelatePlugin, initial = "") {
		super(plugin.app);
		this.modalEl.addClass("relate-search");
		this.setPlaceholder("Search notes");
		this.setInstructions([
			{ command: "↵", purpose: "open" },
			{ command: Platform.isMacOS ? "⌘ ↵" : "Ctrl ↵", purpose: "open in new tab" },
			{ command: "esc", purpose: "close" },
		]);
		this.chipsEl = createDiv({ cls: "relate-chips" });
		this.inputEl.parentElement?.insertAdjacentElement("afterend", this.chipsEl);
		this.emptyStateText = "No matching notes.";
		if (initial) this.inputEl.value = initial;
	}

	onOpen(): void {
		void super.onOpen();
		void this.plugin.search.ensureBuilt();
		this.renderTips();
	}

	private renderTips(): void {
		this.chipsEl.empty();
		const sides = [...this.plugin.sides().keys()];
		const tips = this.chipsEl.createDiv({ cls: "relate-tips" });
		tips.appendText(this.plugin.semantic.ready ? "Type words or describe an idea. To narrow it, add " : "Type words to search. To narrow it, add ");
		const examples = [sides.length ? `${sides[0]} of [note]` : null, "connected to [note]", "last month"].filter((x): x is string => !!x);
		examples.forEach((ex, i) => {
			if (i) tips.appendText(i === examples.length - 1 ? " or " : ", ");
			tips.createEl("code", { text: ex });
		});
		tips.appendText(".");
	}

	private renderChips(chips: Chip[], query: string): void {
		this.chipsEl.empty();
		if (!chips.length) {
			if (!query) this.renderTips();
			return;
		}
		for (const chip of chips) {
			const el = this.chipsEl.createDiv({ cls: `relate-chip relate-chip-${chip.kind}` });
			const label = el.createEl("button", { cls: "relate-chip-label relate-button-reset", text: chipText(chip), attr: { type: "button", "aria-label": `Change “${chipText(chip)}”` } });
			label.addEventListener("click", (e) => this.chipMenu(chip, e));
			const x = el.createEl("button", { cls: "relate-chip-x relate-button-reset", attr: { "aria-label": `Remove “${chipText(chip)}”`, type: "button" } });
			setIcon(x, "x");
			x.addEventListener("click", () => {
				this.inputEl.value = removeChip(this.inputEl.value, chip);
				this.inputEl.dispatchEvent(new Event("input"));
				this.inputEl.focus();
			});
		}
	}

	/** Lets the user change a chip without retyping: another relationship, chains on or off, another date. */
	private chipMenu(chip: Chip, evt: MouseEvent): void {
		const menu = new Menu();
		const write = (text: string) => {
			this.inputEl.value = replaceChip(this.inputEl.value, chip, text);
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.focus();
		};
		if (chip.kind === "relation") {
			const sides = this.plugin.sides();
			const outer = chip.chain[0];
			for (const side of sides.values()) {
				if (side.prop === outer.prop) continue;
				menu.addItem((i) =>
					i.setTitle(`Change to “${side.prop}”`).onClick(() => write(chipToText({ ...chip, chain: [{ ...outer, prop: side.prop, label: side.prop }, ...chip.chain.slice(1)] })))
				);
			}
			const side = sides.get(outer.prop);
			if (side?.chains) {
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle(outer.all ? "Direct links only" : "Follow the whole chain")
						.setIcon(outer.all ? "minus" : "git-branch")
						.onClick(() => write(chipToText({ ...chip, chain: [{ ...outer, all: !outer.all }, ...chip.chain.slice(1)] })))
				);
			}
		} else if (chip.kind === "date") {
			for (const d of ["today", "this week", "last week", "this month", "last month", "this year"]) {
				if (d !== chip.label) menu.addItem((i) => i.setTitle(d).onClick(() => write(d)));
			}
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Remove").setIcon("x").onClick(() => write("")));
		menu.showAtMouseEvent(evt);
	}

	async getSuggestions(query: string): Promise<SearchResult[]> {
		this.lastQuery = query;
		const parsed = this.plugin.search.parse(query);
		this.renderChips(parsed.chips, query.trim());
		if (!query.trim()) return [];
		const results = await this.plugin.search.run(parsed);
		// Drop stale answers when the user kept typing.
		return query === this.lastQuery ? results : [];
	}

	renderSuggestion(r: SearchResult, el: HTMLElement): void {
		el.addClass("mod-complex", "relate-result");
		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({ cls: "suggestion-title", text: r.file.basename });
		if (r.reasons.length) content.createDiv({ cls: "suggestion-note relate-result-why", text: r.reasons.join(" · ") });
		for (const path of r.paths) {
			const line = content.createDiv({ cls: "suggestion-note relate-path" });
			line.createSpan({ cls: "relate-path-note", text: r.file.basename });
			for (const step of path) {
				line.createSpan({ cls: "relate-path-prop", text: ` → ${step.prop}: ` });
				const name = step.to.replace(/^.*\//, "").replace(/\.md$/, "");
				const a = line.createEl("a", { cls: "relate-path-note internal-link", text: name, href: "#" });
				a.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					const f = this.app.vault.getAbstractFileByPath(step.to);
					if (f instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(e) ? "tab" : false).openFile(f);
					this.close();
				});
			}
		}
		if (r.snippet) content.createDiv({ cls: "suggestion-note relate-result-snippet", text: r.snippet });
		const folder = r.file.parent?.path;
		if (folder && folder !== "/") {
			const aux = el.createDiv({ cls: "suggestion-aux" });
			aux.createSpan({ cls: "suggestion-flair relate-result-folder", text: folder });
		}
	}

	onChooseSuggestion(r: SearchResult, evt: MouseEvent | KeyboardEvent): void {
		void this.app.workspace.getLeaf(Keymap.isModEvent(evt) ? "tab" : false).openFile(r.file);
	}
}
