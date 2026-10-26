import { Notice, TFile, requireApiVersion } from "obsidian";
import type RelatePlugin from "../main";
import type { Side } from "../settings";
import { baseBlock } from "../bases";
import { AdoptModal, HealthModal, SidePickerModal, linkAs } from "./modals";
import { LinkManyModal, NewLinkedNoteModal, linkSelected } from "./linking";
import { SearchModal } from "./search-modal";
import { showPaths } from "./paths-modal";

/** Registers Relate's commands and its file menu entries. None has a default hotkey. */
export function registerCommands(plugin: RelatePlugin): void {
	plugin.addCommand({ id: "search", name: "Search notes", callback: () => new SearchModal(plugin).open() });
	plugin.addCommand({
		id: "link-as",
		name: "Link this note to another note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") return false;
			if (!checking) linkAs(plugin, file);
			return true;
		},
	});
	const withSide = (file: TFile, fn: (s: Side) => void) =>
		plugin.sides().size ? new SidePickerModal(plugin, file, fn).open() : plugin.openSettings();
	plugin.addCommand({
		id: "new-linked-note",
		name: "Create a new note linked to this note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") return false;
			if (!checking) withSide(file, (s) => new NewLinkedNoteModal(plugin, file, s).open());
			return true;
		},
	});
	plugin.addCommand({
		id: "link-several",
		name: "Link several notes to this note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") return false;
			if (!checking) withSide(file, (s) => new LinkManyModal(plugin, file, s).open());
			return true;
		},
	});
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md" || !plugin.sides().size) return;
			menu.addItem((i) => i.setTitle("Create a linked note…").setIcon("file-plus").setSection("action").onClick(() => withSide(file, (s) => new NewLinkedNoteModal(plugin, file, s).open())));
		})
	);
	plugin.registerEvent(
		plugin.app.workspace.on("files-menu", (menu, files) => {
			const notes = files.filter((f): f is TFile => f instanceof TFile && f.extension === "md");
			if (notes.length < 2 || !plugin.sides().size) return;
			menu.addItem((i) => i.setTitle(`Link ${notes.length} notes to a note…`).setIcon("link").setSection("action").onClick(() => linkSelected(plugin, notes)));
		})
	);
	plugin.addCommand({ id: "show-connections", name: "Open the connections panel", callback: () => void plugin.activateView() });
	plugin.addCommand({ id: "open-browser", name: "Open the relationship browser", callback: () => void plugin.openBrowser() });
	plugin.addCommand({
		id: "browse-note",
		name: "Browse this note's relationships",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") return false;
			if (!checking) void plugin.openBrowser(file.path);
			return true;
		},
	});
	plugin.addCommand({
		id: "show-paths",
		name: "How is this note connected to another note?",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md" || !plugin.sides().size) return false;
			if (!checking) showPaths(plugin, file);
			return true;
		},
	});
	plugin.addCommand({
		id: "insert-base",
		name: "Insert a table of notes linked to this note",
		editorCheckCallback: (checking, editor, ctx) => {
			const file = ctx.file;
			// Bases arrived in Obsidian 1.9.
			if (!file || !plugin.sides().size || !requireApiVersion("1.9.0")) return false;
			if (!checking) {
				new SidePickerModal(plugin, file, (side) => editor.replaceSelection(baseBlock(side)), "Choose which related notes to list").open();
			}
			return true;
		},
	});
	plugin.addCommand({
		id: "copy-base",
		name: "Copy a table of notes linked to this note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || file.extension !== "md" || !plugin.sides().size || !requireApiVersion("1.9.0")) return false;
			if (!checking) {
				new SidePickerModal(plugin, file, (side) => {
					void navigator.clipboard.writeText(baseBlock(side)).then(
						() => new Notice(`Copied a table of ${side.prop}. Paste it into any note.`),
						() => new Notice("Relate could not reach the clipboard.")
					);
				}, "Choose which related notes to list").open();
			}
			return true;
		},
	});
	plugin.addCommand({ id: "whats-new", name: "Show what's new", callback: () => plugin.showWhatsNew() });
	plugin.addCommand({ id: "find-relationships", name: "Find links in your vault", callback: () => new AdoptModal(plugin).open() });
	plugin.addCommand({ id: "check-links", name: "Check links", callback: () => new HealthModal(plugin).open() });
	plugin.addCommand({ id: "search-by-meaning", name: "Turn on search by meaning", callback: () => plugin.turnOnMeaning() });
	plugin.addCommand({
		id: "rebuild-meaning-index",
		name: "Rebuild the meaning index",
		checkCallback: (checking) => {
			if (!plugin.settings.semantic.enabled) return false;
			if (!checking) void plugin.semantic.rebuild();
			return true;
		},
	});

	plugin.addCommand({
		id: "undo",
		name: "Undo the last change",
		callback: async () => {
			const last = plugin.history.latest();
			if (!last) {
				new Notice("Relate has no change to undo.");
				return;
			}
			await plugin.history.undo(last.id);
		},
	});
}
