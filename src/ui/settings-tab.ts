import { PluginSettingTab, type App, type Setting, type SettingDefinitionItem } from "obsidian";
import type RelatePlugin from "../main";
import { availablePresets, type Relation, type RelateSettings } from "../settings";
import { AdoptModal, HealthModal } from "./modals";
import { RelationModal } from "./relation-modal";
import { BUILTIN } from "../semantic/embedders";

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Settings that a plain control edits, by key. Nested ones use a dotted key. */
const SCALARS = ["autoSync", "mirrorRemovals", "dateSource", "dateProperty", "showReleaseNotes"] as const;
const MEANING = ["source", "serverUrl", "serverModel", "secretId"] as const;
type Scalar = (typeof SCALARS)[number];
type Meaning = (typeof MEANING)[number];

const isScalar = (k: string): k is Scalar => (SCALARS as readonly string[]).includes(k);
const meaningKey = (k: string): Meaning | null => {
	const m = /^semantic\.(\w+)$/.exec(k)?.[1];
	return m && (MEANING as readonly string[]).includes(m) ? (m as Meaning) : null;
};

/** How a relationship reads in the list: "parent ↔ children", or "related (both ways)". */
export function relationTitle(r: Relation): string {
	return r.property === r.inverse ? `${r.property} (both ways)` : `${r.property} ↔ ${r.inverse}`;
}

function relationSummary(r: Relation): string {
	const bits: string[] = [];
	if (r.propertyOne) bits.push(`one ${r.property} per note`);
	if (r.inverseOne && r.inverse !== r.property) bits.push(`one ${r.inverse} per note`);
	if (r.chains) bits.push("search follows chains");
	if (r.required) bits.push(`notes ${r.required.startsWith("#") ? "tagged" : "in"} ${r.required} need one`);
	const text = bits.join(" · ");
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Any number of links on each side";
}

export class RelateSettingTab extends PluginSettingTab {
	private restartTimer: number | null = null;

	constructor(app: App, private plugin: RelatePlugin) {
		super(app, plugin);
	}

	// ------------------------------------------------------------ bindings

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (isScalar(key)) return s[key];
		const m = meaningKey(key);
		return m ? s.semantic[m] : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "dateSource") {
			if (value === "modified" || value === "created" || value === "property") s.dateSource = value;
		} else if (key === "dateProperty" && typeof value === "string") {
			s.dateProperty = value.trim();
		} else if ((key === "autoSync" || key === "mirrorRemovals" || key === "showReleaseNotes") && typeof value === "boolean") {
			s[key] = value;
			if (key === "showReleaseNotes" && !value) this.plugin.dismissReleaseNotes();
		} else {
			const m = meaningKey(key);
			if (!m || typeof value !== "string") return;
			if (m === "source") {
				if (value !== "builtin" && value !== "server") return;
				s.semantic.source = value;
			} else {
				// Typing an address agrees to nothing. Search by meaning stays waiting until this device agrees to
				// that exact address, in the consent window or with the button beside the status.
				s.semantic[m] = value.trim();
			}
			this.restartMeaning(m === "source" ? 0 : 1000);
		}
		await this.plugin.saveSettings();
		this.update();
	}

	/** Restarts search by meaning once typing pauses, so each keystroke does not start a new index run. */
	private restartMeaning(delay: number): void {
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			if (this.plugin.settings.semantic.enabled) void this.plugin.semantic.start();
		}, delay);
	}

	// --------------------------------------------------------- definitions

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		return [this.relationships(s), this.setup(s), this.linking(), this.search(s), this.meaning(s), this.releases(), this.history()];
	}

	private relationships(s: RelateSettings): SettingDefinitionItem {
		return {
			type: "list",
			heading: "Relationships",
			emptyState: "No relationships yet. Add one, start from a common setup, or let Relate find the properties that already link your notes.",
			addItem: { name: "Add a relationship", action: () => new RelationModal(this.plugin, null, () => this.update()).open() },
			onDelete: (i) => void this.deleteRelation(i),
			items: s.relations.map((r, i) => ({
				name: relationTitle(r),
				desc: relationSummary(r),
				aliases: [r.property, r.inverse],
				render: (setting: Setting) => {
					setting.addExtraButton((b) =>
						b
							.setIcon("pencil")
							.setTooltip("Edit this relationship")
							.onClick(() => new RelationModal(this.plugin, i, () => this.update()).open())
					);
				},
			})),
		};
	}

	/** Deleting a relationship leaves every note as it is. */
	private async deleteRelation(i: number): Promise<void> {
		this.plugin.settings.relations.splice(i, 1);
		await this.plugin.saveSettings();
		this.plugin.relationsChanged();
		this.update();
	}

	private setup(s: RelateSettings): SettingDefinitionItem {
		const presets = availablePresets(s.relations);
		return {
			type: "group",
			items: [
				{
					name: "Start from a common setup",
					desc: "Projects and notes, parents and children, people and meetings, and more. Adding one changes no notes.",
					visible: presets.length > 0,
					render: (setting: Setting) => {
						let pick = presets[0]?.name ?? "";
						setting
							.addDropdown((d) => {
								for (const p of presets) d.addOption(p.name, p.name);
								d.setValue(pick).onChange((v) => (pick = v));
							})
							.addButton((b) =>
								b.setButtonText("Add").onClick(() => {
									const p = presets.find((x) => x.name === pick);
									if (p) void this.addPreset(p.relation);
								})
							);
					},
				},
				{
					name: "Find links in your vault",
					desc: "See which properties already link notes, and turn them into relationships.",
					aliases: ["adopt", "scan"],
					action: () => new AdoptModal(this.plugin).open(),
				},
				{
					name: "Check links",
					desc: "Find links recorded on one note only, and notes that compete for a property that holds only one link.",
					aliases: ["repair", "health"],
					action: () => new HealthModal(this.plugin).open(),
				},
			],
		};
	}

	private async addPreset(relation: Relation): Promise<void> {
		this.plugin.settings.relations.push({ ...relation });
		await this.plugin.saveSettings();
		this.plugin.relationsChanged();
		this.update();
	}

	private linking(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Linking both ways",
			items: [
				{
					name: "Update the other note",
					desc: "When you add a note to a relationship property, Relate adds the link back on that note. When this is off, only the connections panel and the command to link a note update both notes.",
					control: { type: "toggle", key: "autoSync" },
				},
				{
					name: "Remove from the other note too",
					desc: "When you remove a link, Relate removes the link back as well, and shows a notice in case you want to undo it.",
					control: { type: "toggle", key: "mirrorRemovals" },
				},
			],
		};
	}

	private search(s: RelateSettings): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Search",
			items: [
				{
					name: "Dates in search",
					desc: "Which date a search such as “last month” or “2026-09” looks at.",
					control: {
						type: "dropdown",
						key: "dateSource",
						options: { modified: "Date modified", created: "Date created", property: "A date property" },
					},
				},
				{
					name: "Date property",
					desc: "The property that holds each note's date, such as “date” or “created”.",
					visible: s.dateSource === "property",
					control: { type: "text", key: "dateProperty", placeholder: "date" },
				},
			],
		};
	}

	private meaning(s: RelateSettings): SettingDefinitionItem {
		const sem = this.plugin.semantic;
		const server = () => this.plugin.settings.semantic.source === "server";
		return {
			type: "group",
			heading: "Search by meaning",
			items: [
				{
					name: "Turn on search by meaning",
					desc:
						s.semantic.source === "builtin"
							? `Find notes about an idea even when they use different words. Uses ${BUILTIN.name}, a small language model (${BUILTIN.sizeLabel}) that runs on this device. Relate asks before it downloads the model.`
							: "Find notes about an idea even when they use different words. Uses the server below.",
					aliases: ["semantic", "embeddings", "similar notes"],
					render: (setting: Setting) => {
						setting.addToggle((t) =>
							t.setValue(s.semantic.enabled).onChange((on) => {
								if (on) {
									// If the download is cancelled, the toggle goes back to off.
									this.plugin.turnOnMeaning(() => void t.setValue(false));
									return;
								}
								void this.turnOffMeaning();
							})
						);
					},
				},
				{
					name: "Status",
					render: (setting: Setting) => {
						const state = sem.status.state;
						setting.setDesc(this.statusText());
						if (s.semantic.enabled && state === "needs-consent") {
							setting.addButton((b) =>
								b
									.setButtonText("Allow on this device")
									.setCta()
									.onClick(() => {
										this.plugin.consent.allowServer(this.plugin.settings.semantic.serverUrl);
										void sem.start();
									})
							);
						}
						if (s.semantic.enabled && state === "needs-download") {
							setting.addButton((b) => b.setButtonText(`Download (${BUILTIN.sizeLabel})`).setCta().onClick(() => this.plugin.turnOnMeaning()));
						}
						if (s.semantic.enabled && (state === "ready" || state === "error")) {
							setting.addButton((b) => b.setButtonText("Rebuild").onClick(() => void sem.rebuild()));
						}
						setting.addButton((b) => b.setButtonText("Remove from this device").setDestructive().onClick(() => void this.removeMeaning()));
						// Progress updates the line; a new state redraws the buttons.
						return sem.onChange(() => {
							if (sem.status.state !== state) this.update();
							else setting.setDesc(this.statusText());
						});
					},
				},
				{
					name: "Model",
					desc: "The built-in model works offline after one download. Your own server, such as Ollama or LM Studio, can run a larger model.",
					control: { type: "dropdown", key: "semantic.source", options: { builtin: `Built-in (${BUILTIN.name})`, server: "My own server" } },
				},
				{
					name: "Server address",
					desc: "Any server with an OpenAI-compatible embeddings endpoint. Relate sends the text of your notes to this address to index them.",
					visible: server,
					control: { type: "text", key: "semantic.serverUrl", placeholder: "http://localhost:11434" },
				},
				{
					name: "Model name",
					desc: "The embedding model on that server, such as nomic-embed-text.",
					visible: server,
					control: { type: "text", key: "semantic.serverModel", placeholder: "nomic-embed-text" },
				},
				{
					name: "Key",
					desc: "Only if the server asks for one. Pick or add it in Obsidian's keychain; Relate stores only its name.",
					visible: server,
					control: { type: "secret", key: "semantic.secretId" },
				},
			],
		};
	}

	private async turnOffMeaning(): Promise<void> {
		this.plugin.settings.semantic.enabled = false;
		await this.plugin.saveSettings();
		await this.plugin.semantic.start();
		this.update();
	}

	private async removeMeaning(): Promise<void> {
		this.plugin.settings.semantic.enabled = false;
		await this.plugin.saveSettings();
		await this.plugin.semantic.remove();
		this.update();
	}

	private statusText(): string {
		const sem = this.plugin.semantic;
		const s = sem.status;
		switch (s.state) {
			case "off":
				return "Off.";
			case "needs-download":
				return s.message.startsWith("The model download failed") || !sem.persistent ? s.message : "On, but this device does not have the model yet.";
			case "indexing":
				return `Indexing notes on this device: ${s.done} of ${s.total}.`;
			case "ready":
				return `Ready. ${sem.count} ${sem.count === 1 ? "note is" : "notes are"} indexed on this device.`;
			default:
				return s.message;
		}
	}

	private releases(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "What's new",
			items: [
				{
					name: "Announce updates",
					desc: "After an update, show a line at the top of the connections panel that opens the release notes.",
					control: { type: "toggle", key: "showReleaseNotes" },
				},
				{ name: "Show what's new", desc: "The notes for recent releases.", action: () => this.plugin.showWhatsNew() },
			],
		};
	}

	private history(): SettingDefinitionItem {
		return {
			type: "list",
			heading: "Recent changes",
			emptyState: "Relate has not changed any notes yet.",
			items: [...this.plugin.history.list()]
				.reverse()
				.slice(0, 10)
				.map((batch) => ({
					name: batch.label,
					desc: `${new Date(batch.time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${plural(batch.count ?? batch.ops.length, "change", "changes")}`,
					searchable: false,
					render: (setting: Setting) => {
						if (!batch.undoable) return;
						setting.addButton((b) =>
							b.setButtonText("Undo").onClick(async () => {
								b.setDisabled(true);
								await this.plugin.history.undo(batch.id);
								this.update();
							})
						);
					},
				})),
		};
	}
}
