import { Notice, Plugin, TFile, normalizePath, type Events } from "obsidian";
import { sidesOf, validateRelations, type Relation, type RelateSettings, type Side } from "./settings";
import { EdgeIndex } from "./graph";
import { Writer } from "./writer";
import { SyncEngine } from "./sync";
import { SearchService } from "./search/service";
import { ConnectionsView, VIEW_TYPE } from "./ui/connections-view";
import { BROWSER_VIEW, BrowserView } from "./ui/browser-view";
import { SearchModal } from "./ui/search-modal";
import { AdoptModal } from "./ui/modals";
import { RelateSettingTab } from "./ui/settings-tab";
import { SemanticIndex } from "./semantic/index";
import { ConsentModal, ServerConsentModal } from "./ui/consent-modal";
import { Consent, meaningPlan, type DeviceStorage } from "./semantic/consent";
import { BUILTIN } from "./semantic/embedders";
import { icons } from "./ui/icons";
import { recentNotes } from "./release-notes";
import { ReleaseState } from "./release-state";
import { WelcomeModal, WhatsNewModal } from "./ui/whats-new";
import { SettingsStore } from "./settings-store";
import { History, type PluginFiles } from "./history";
import { RelationQueries } from "./queries";
import { registerCommands } from "./ui/commands";
import { EVENT_CHANGED, EVENT_READY, EVENT_REQUEST, EVENT_UNLOAD, createApi, type RelateApi } from "./api";

export type { RelateApi } from "./api";

/**
 * Relate's composition root. It builds the services, wires them to Obsidian's events, and registers the views,
 * commands and settings. The services hold the logic; this class only connects them.
 */
export default class RelatePlugin extends Plugin {
	/** The settings in use: the store's object, which a reload from sync updates in place. */
	settings!: RelateSettings;
	private store = new SettingsStore({ load: () => this.loadData(), save: (data) => this.saveData(data) });
	index!: EdgeIndex;
	writer!: Writer;
	history!: History;
	sync!: SyncEngine;
	search!: SearchService;
	semantic!: SemanticIndex;
	/** What this device agreed to: the model download, and the server it may send note text to. */
	consent!: Consent;
	queries!: RelationQueries;
	/** Release notes waiting for the reader. */
	releases!: ReleaseState;
	private statusEl: HTMLElement | null = null;
	/** The frozen API every other plugin receives with `relate:ready`. */
	api!: RelateApi;
	private sidesCache: Map<string, Side> | null = null;
	private settingTab!: RelateSettingTab;
	private refreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		const storage: DeviceStorage = { load: (key): unknown => this.app.loadLocalStorage(key), save: (key, value) => this.app.saveLocalStorage(key, value) };
		this.releases = new ReleaseState({ version: this.manifest.version, storage, settings: this.settings, save: () => void this.saveSettings() });
		this.releases.review(!this.settings.welcomed);
		this.index = new EdgeIndex(this.app, () => new Set(this.sides().keys()));
		this.queries = new RelationQueries(this.index, () => this.sides());
		this.writer = new Writer(this.app);
		this.history = new History({
			files: this.files(),
			path: this.pluginPath("history.json"),
			reverse: (label, ops) => this.sync.undo(label, ops),
			notify: (message, ms) => new Notice(message, ms),
			reportError: (where, e) => void this.reportError(where, e),
		});
		await this.moveLegacyHistory();
		this.sync = new SyncEngine(this);
		this.search = new SearchService(this);
		this.consent = new Consent(storage, BUILTIN.id);
		this.semantic = new SemanticIndex(this, this.consent);
		this.api = createApi({
			index: this.index,
			sides: () => this.sides(),
			relations: () => this.settings.relations,
			queries: this.queries,
			search: (q) => this.search.run(this.search.parse(q), { snippets: false }),
			semantic: this.semantic,
			note: (path) => {
				const f = this.app.vault.getAbstractFileByPath(path);
				return f instanceof TFile && f.extension === "md" ? f : null;
			},
			connect: (file, side, target) => this.sync.connect(file, side, target),
			disconnect: (file, side, targetPath) => this.sync.disconnect(file, side, targetPath),
			changed: () => this.refreshViews(),
		});

		this.registerView(VIEW_TYPE, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(BROWSER_VIEW, (leaf) => new BrowserView(leaf, this));
		this.settingTab = new RelateSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon(icons.main(), "Open the relationship browser", () => void this.openBrowser());

		registerCommands(this);

		// obsidian://relate?search=… opens search with a query; obsidian://relate?browse=… opens the browser on a note.
		this.registerObsidianProtocolHandler("relate", (params) => {
			if (params.search !== undefined) {
				new SearchModal(this, params.search).open();
			} else if (params.browse) {
				const f = this.app.metadataCache.getFirstLinkpathDest(params.browse, "");
				void this.openBrowser(f?.path);
			}
		});

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("relate-status");
		this.semantic.onChange(() => {
			this.showStatus();
			this.refreshViews();
		});
		// Other plugins find the API through public workspace events: Relate announces it when ready, answers a
		// request from a plugin that loaded later, and says when it leaves.
		const bus: Events = this.app.workspace;
		this.registerEvent(bus.on(EVENT_REQUEST, () => this.announce()));
		this.app.workspace.onLayoutReady(() => {
			this.announce();
			this.sync.start();
			void this.semantic.start();
			this.registerEvent(this.app.vault.on("modify", (file) => file instanceof TFile && this.semantic.onModify(file)));
			this.registerEvent(
				this.app.metadataCache.on("changed", (file) => {
					this.search.markDirty(file.path);
					this.sync.onChanged(file);
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					if (!(file instanceof TFile)) return;
					this.index.rename(oldPath, file.path);
					this.sync.onRename(oldPath, file.path);
					this.search.onRename(oldPath, file.path);
					this.semantic.onRename(oldPath, file);
					this.refreshViews();
				})
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					this.index.delete(file.path);
					this.sync.onDelete(file.path);
					this.search.onDelete(file.path);
					this.semantic.onDelete(file.path);
					this.refreshViews();
				})
			);
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (!(file instanceof TFile)) return;
					this.search.markDirty(file.path);
					this.semantic.onModify(file);
				})
			);
			if (!this.settings.welcomed) {
				this.settings.welcomed = true;
				void this.saveSettings();
				void this.activateView(false);
				new WelcomeModal(this).open();
			} else if (!this.settings.panelClosed && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) {
				// Obsidian closes plugin panels when the plugin is turned off. Put the panel back, unrevealed.
				void this.activateView(false);
			}
		});
	}

	/** True while Obsidian unloads the plugin, so panels closing then are not mistaken for the user closing them. */
	unloading = false;

	/** Records an error in the settings file and the console, and returns a plain message for the panel. */
	reportError(where: string, e: unknown): string {
		const message = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
		console.error(`Relate (${where}):`, e);
		this.settings.errors = [...(this.settings.errors ?? []), { time: Date.now(), where, message }].slice(-5);
		void this.saveData(this.settings);
		return e instanceof Error ? e.message : String(e);
	}

	onunload(): void {
		this.unloading = true;
		this.app.workspace.trigger(EVENT_UNLOAD);
		// Obsidian removes registered events and views. Notes are left exactly as they are.
		this.sync?.stop();
		this.semantic?.stop();
		this.search?.stop();
		void this.history?.flush();
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}

	/** The plugin's own folder, through Obsidian's vault adapter. */
	private files(): PluginFiles {
		const adapter = this.app.vault.adapter;
		return { exists: (p) => adapter.exists(p), read: (p) => adapter.read(p), write: (p, d) => adapter.write(p, d) };
	}

	/** A normalized path to `name` in the plugin's own folder. */
	private pluginPath(name: string): string {
		return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/${name}`);
	}

	/**
	 * Reads the history file, and moves any history an earlier version kept in the settings file into it. The
	 * settings file keeps that history until the history file has it.
	 */
	private async moveLegacyHistory(): Promise<void> {
		const legacy = this.store.legacyHistory;
		if ((await this.history.load(legacy)) && legacy.length) {
			this.store.legacyHistory = [];
			await this.saveSettings();
		}
	}

	async loadSettings(): Promise<void> {
		await this.store.load();
		this.settings = this.store.settings;
		const { problems } = this.store;
		if (problems.length) {
			this.settings.errors = [...this.settings.errors, { time: Date.now(), where: "Settings file", message: problems.join(" ") }].slice(-5);
			new Notice(`Relate found problems in its settings file and used safe values instead: ${problems[0]}`, 10000);
		}
	}

	async saveSettings(): Promise<void> {
		this.sidesCache = null;
		await this.store.save();
	}

	/**
	 * Obsidian calls this when the settings file changes on disk, usually because sync brought a copy from another
	 * device. Relate takes that copy, re-reads the history file, and re-reads whatever the change affects, so its next
	 * save never overwrites what the other device wrote.
	 */
	async onExternalSettingsChange(): Promise<void> {
		if (!this.index) return;
		const change = await this.store.reload();
		if (!change) {
			this.reportError("Settings from another device", new Error("The settings file that arrived by sync had problems, so Relate kept the settings it had."));
			return;
		}
		this.sidesCache = null;
		await this.history.reload();
		if (this.store.legacyHistory.length) await this.moveLegacyHistory();
		if (change.relations) this.relationsChanged();
		if (change.meaning) void this.semantic.start();
		this.settingTab?.update();
		this.refreshViews();
	}

	/** Relationship sides. Empty while the relationship list has a problem, so nothing is written into the wrong property. */
	sides(): Map<string, Side> {
		if (!this.sidesCache) {
			this.sidesCache = this.relationsValid() ? sidesOf(this.settings.relations) : new Map();
		}
		return this.sidesCache;
	}

	relationsValid(): boolean {
		return validateRelations(this.settings.relations).length === 0;
	}

	/** Re-reads the vault after relationships change. Writes nothing. */
	relationsChanged(): void {
		this.sidesCache = null;
		this.sync.resnapshot();
		// The settings tab lists the relationships; keep it in step with changes made elsewhere.
		this.settingTab?.update();
		this.refreshViews();
	}

	/** Adds relationships from the vault scan. Returns plain-language problems instead of saving a broken list. */
	addRelations(relations: Relation[]): string[] {
		const next = [...this.settings.relations, ...relations];
		const problems = validateRelations(next);
		if (problems.length) return problems;
		this.settings.relations = next;
		this.sidesCache = null;
		return [];
	}

	/** Opens the unseen notes, which closing marks read, or else the latest releases. */
	showWhatsNew(): void {
		const unseen = this.releases.notes.length > 0;
		const notes = unseen ? this.releases.notes : recentNotes(this.manifest.version);
		new WhatsNewModal(this, notes, unseen ? () => this.dismissReleaseNotes() : undefined).open();
	}

	/** Marks the announced release notes read and takes the notice away. */
	dismissReleaseNotes(): void {
		if (this.releases.dismiss()) this.refreshViews();
	}

	/**
	 * Resolves once Obsidian has re-read every note in `paths`, so the index shows Relate's latest writes, or after
	 * `limit` milliseconds, whichever comes first.
	 */
	afterIndexed(paths: string[], limit = 4000): Promise<void> {
		const waiting = new Set(paths);
		if (!waiting.size) return Promise.resolve();
		return new Promise((resolve) => {
			let ref: ReturnType<typeof this.app.metadataCache.on> | null = null;
			const finish = () => {
				if (ref) this.app.metadataCache.offref(ref);
				ref = null;
				window.clearTimeout(timer);
				resolve();
			};
			const timer = window.setTimeout(finish, limit);
			ref = this.app.metadataCache.on("changed", (file) => {
				waiting.delete(file.path);
				// Relate's own listener updates the index first; this runs after it.
				if (!waiting.size) window.setTimeout(finish, 0);
			});
			this.registerEvent(ref);
		});
	}

	async connect(file: TFile, side: Side, target: TFile): Promise<void> {
		const out = await this.sync.connect(file, side, target);
		this.sync.report(out, `Linked ${file.basename} and ${target.basename}.`);
	}

	private announced = "";

	/** Hands the API to any plugin listening for it. */
	private announce(): void {
		if (!this.unloading) this.app.workspace.trigger(EVENT_READY, this.api);
	}

	/** Tells listeners that links or the meaning index changed, once per change. */
	private announceChange(): void {
		const now = `${this.index.revision}:${this.semantic.status.state}:${this.semantic.count}`;
		if (now === this.announced) return;
		this.announced = now;
		this.app.workspace.trigger(EVENT_CHANGED);
	}

	refreshViews(): void {
		if (this.unloading) return;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.announceChange();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				if (leaf.view instanceof ConnectionsView) leaf.view.render();
			}
			for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW)) {
				if (leaf.view instanceof BrowserView) leaf.view.render();
			}
		}, 150);
	}

	async activateView(reveal = true): Promise<void> {
		const { workspace } = this.app;
		if (this.settings.panelClosed) {
			this.settings.panelClosed = false;
			void this.saveSettings();
		}
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE, active: reveal });
			leaf = right;
		}
		if (reveal) await workspace.revealLeaf(leaf);
	}

	/** Opens the relationship browser in a tab, optionally focused on one note. */
	async openBrowser(path?: string): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(BROWSER_VIEW)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: BROWSER_VIEW, active: true, state: path ? { relation: "", path: [path] } : {} });
		} else if (path && leaf.view instanceof BrowserView) {
			leaf.view.focusNote(path);
		}
		await workspace.revealLeaf(leaf);
	}

	/** Shows indexing progress in the status bar, and hides it when there is nothing to report. */
	private showStatus(): void {
		const el = this.statusEl;
		if (!el) return;
		const s = this.semantic.status;
		const text =
			s.state === "downloading" ? "Relate: downloading model" :
			s.state === "preparing" ? "Relate: preparing model" :
			s.state === "indexing" ? `Relate: indexing ${s.done} of ${s.total}` : "";
		el.setText(text);
		el.toggle(!!text);
	}

	/**
	 * Turns on search by meaning. Asks first when this device has not agreed to download the model, or to send note
	 * text to the server's exact address. `onCancel` runs when the user says no.
	 */
	turnOnMeaning(onCancel?: () => void): void {
		const enable = async () => {
			this.settings.semantic.enabled = true;
			await this.saveSettings();
		};
		const plan = meaningPlan(this.settings.semantic, this.consent);
		if (plan.kind === "start" || plan.kind === "needs-address") {
			// Without an address, starting shows what is missing in the status line and in settings.
			void enable().then(() => this.semantic.start());
			return;
		}
		if (plan.kind === "ask-server") {
			new ServerConsentModal(
				this,
				plan.url,
				async () => {
					this.consent.allowServer(plan.url);
					await enable();
					await this.semantic.start();
				},
				onCancel
			).open();
			return;
		}
		new ConsentModal(
			this,
			async () => {
				await enable();
				try {
					await this.semantic.download();
				} catch (e) {
					const msg = this.reportError("Downloading the model", e);
					new Notice(`Relate could not download the model: ${msg}`, 10000);
					this.consent.forgetModel();
				}
				await this.semantic.start();
			},
			onCancel
		).open();
	}

	/** Starts setting up a relationship: Relate's own setup window, with the vault's links and common setups. */
	openSettings(): void {
		new AdoptModal(this).open();
	}
}
