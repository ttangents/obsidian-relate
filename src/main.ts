import { Notice, Plugin, TFile, requireApiVersion, type Events } from "obsidian";
import { sidesOf, validateRelations, type HistoryOp, type Relation, type RelateSettings, type Side } from "./settings";
import { EdgeIndex, traverse } from "./graph";
import { Writer } from "./writer";
import { SyncEngine } from "./sync";
import { SearchService } from "./search/service";
import { ConnectionsView, VIEW_TYPE } from "./ui/connections-view";
import { BROWSER_VIEW, BrowserView } from "./ui/browser-view";
import { SearchModal } from "./ui/search-modal";
import { AdoptModal, HealthModal, SidePickerModal, linkAs } from "./ui/modals";
import { LinkManyModal, NewLinkedNoteModal, linkSelected } from "./ui/linking";
import { RelateSettingTab } from "./ui/settings-tab";
import { SemanticIndex } from "./semantic/index";
import { ConsentModal } from "./ui/consent-modal";
import { BUSY_NOTE, showPaths } from "./ui/paths-modal";
import { findPaths, stepsFrom } from "./paths";
import { baseBlock } from "./bases";
import { icons } from "./ui/icons";
import { laterVersion, recentNotes, unseenNotes, type ReleaseNote } from "./release-notes";
import { WelcomeModal, WhatsNewModal } from "./ui/whats-new";
import { SettingsStore } from "./settings-store";

/** This device's copy of the newest release seen; see release-notes.ts. */
const RELEASE_KEY = "relate-release-seen";

const MAX_HISTORY = 30;
const MAX_OPS_PER_BATCH = 5000;
const MAX_CHAIN_DEPTH = 12;

/**
 * The contract other plugins use. Read it from the `relate:ready` workspace event, never from Relate's plugin
 * instance. `version` changes only when a change would break a caller; new members can appear within a version.
 */
export interface RelateApi {
	readonly version: 1;
	/** Notes related to `path` through `prop`, in either direction. Set `all` to follow chains. */
	related(path: string, prop: string, all?: boolean): string[];
	/** Runs a search query exactly as the search box does and returns note paths with reasons. */
	search(query: string): Promise<{ path: string; reasons: string[]; paths: { from: string; prop: string; to: string }[][] }[]>;
	/** Every relationship of the note at `path`, named from its side, whichever note records the link. */
	connections(path: string): { prop: string; path: string }[];
	/** True when search by meaning is on and ready on this device, so `similar` can return notes. */
	meaningReady(): boolean;
	/** Relationship property pairs as configured. */
	relationships(): { property: string; inverse: string }[];
	/** Notes closest in meaning to the note at `path`, best first. Empty when search by meaning is off. */
	similar(path: string, limit?: number): { path: string; score: number }[];
	/**
	 * Short chains of relationships from one note to another, shortest first. Each step is
	 * `{ from, prop, to }`, with `prop` named from the `from` note's side.
	 */
	paths(from: string, to: string, opts?: { property?: string; maxSteps?: number; limit?: number; skipBusy?: boolean }): { from: string; prop: string; to: string }[][];
	/** Links two notes on both sides, as the Connections panel does. Resolves to false, with a reason, when nothing changed. */
	connect(from: string, property: string, to: string): Promise<{ ok: boolean; reason?: string }>;
	/** Removes a link from both notes. */
	disconnect(from: string, property: string, to: string): Promise<{ ok: boolean; reason?: string }>;
}

/** Workspace events that make up Relate's public contract. */
export const EVENT_READY = "relate:ready";
export const EVENT_REQUEST = "relate:request";
export const EVENT_CHANGED = "relate:changed";
export const EVENT_UNLOAD = "relate:unload";

export default class RelatePlugin extends Plugin {
	/** The settings in use: the store's object, which a reload from sync updates in place. */
	settings!: RelateSettings;
	private store = new SettingsStore({ load: () => this.loadData(), save: (data) => this.saveData(data) });
	index!: EdgeIndex;
	writer!: Writer;
	sync!: SyncEngine;
	search!: SearchService;
	semantic!: SemanticIndex;
	private statusEl: HTMLElement | null = null;
	api!: RelateApi;
	private sidesCache: Map<string, Side> | null = null;
	private settingTab!: RelateSettingTab;
	private refreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.reviewRelease(!this.settings.welcomed);
		this.index = new EdgeIndex(this.app, () => new Set(this.sides().keys()));
		this.writer = new Writer(this.app);
		this.sync = new SyncEngine(this);
		this.search = new SearchService(this);
		this.semantic = new SemanticIndex(this);
		this.api = {
			version: 1,
			connections: (path) => stepsFrom(this.index, this.sides(), path).map((s) => ({ prop: s.prop, path: s.to })),
			meaningReady: () => this.semantic.ready,
			related: (path, prop, all = false) => [...this.related(path, prop, all)],
			search: async (q) =>
				(await this.search.run(this.search.parse(String(q)), { snippets: false })).map((r) => ({
					path: r.file.path,
					reasons: r.reasons,
					paths: r.paths.map((p) => p.map((s) => ({ ...s }))),
				})),
			relationships: () => this.settings.relations.map((r) => ({ property: r.property, inverse: r.inverse })),
			similar: (path, limit = 5) => this.semantic.similar(path, limit),
			paths: (from, to, opts = {}) => {
				const sides = this.sides();
				const side = opts.property ? sides.get(opts.property) : undefined;
				if (opts.property && !side) return [];
				const clamp = (n: number | undefined, d: number, max: number) => Math.max(1, Math.min(max, Math.floor(n ?? d) || d));
				return findPaths(this.index, sides, from, to, {
					props: side ? new Set([side.prop, side.inverse]) : undefined,
					maxSteps: clamp(opts.maxSteps, 6, 10),
					limit: clamp(opts.limit, 5, 20),
					busy: opts.skipBusy ? BUSY_NOTE : null,
				});
			},
			connect: (from, property, to) => this.apiChange(from, property, to, true),
			disconnect: (from, property, to) => this.apiChange(from, property, to, false),
		};
		// Every plugin gets the same object, so none can change it for the others.
		Object.freeze(this.api);

		this.registerView(VIEW_TYPE, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(BROWSER_VIEW, (leaf) => new BrowserView(leaf, this));
		this.settingTab = new RelateSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon(icons.main(), "Open the relationship browser", () => void this.openBrowser());

		this.addCommand({ id: "search", name: "Search notes", callback: () => new SearchModal(this).open() });
		this.addCommand({
			id: "link-as",
			name: "Link this note to another note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) linkAs(this, file);
				return true;
			},
		});
		const withSide = (file: TFile, fn: (s: Side) => void) =>
			this.sides().size ? new SidePickerModal(this, file, fn).open() : this.openSettings();
		this.addCommand({
			id: "new-linked-note",
			name: "Create a new note linked to this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) withSide(file, (s) => new NewLinkedNoteModal(this, file, s).open());
				return true;
			},
		});
		this.addCommand({
			id: "link-several",
			name: "Link several notes to this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) withSide(file, (s) => new LinkManyModal(this, file, s).open());
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md" || !this.sides().size) return;
				menu.addItem((i) => i.setTitle("Create a linked note…").setIcon("file-plus").setSection("action").onClick(() => withSide(file, (s) => new NewLinkedNoteModal(this, file, s).open())));
			})
		);
		this.registerEvent(
			this.app.workspace.on("files-menu", (menu, files) => {
				const notes = files.filter((f): f is TFile => f instanceof TFile && f.extension === "md");
				if (notes.length < 2 || !this.sides().size) return;
				menu.addItem((i) => i.setTitle(`Link ${notes.length} notes to a note…`).setIcon("link").setSection("action").onClick(() => linkSelected(this, notes)));
			})
		);
		this.addCommand({ id: "show-connections", name: "Open the connections panel", callback: () => void this.activateView() });
		this.addCommand({ id: "open-browser", name: "Open the relationship browser", callback: () => void this.openBrowser() });
		this.addCommand({
			id: "browse-note",
			name: "Browse this note's relationships",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.openBrowser(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "show-paths",
			name: "How is this note connected to another note?",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !this.sides().size) return false;
				if (!checking) showPaths(this, file);
				return true;
			},
		});
		this.addCommand({
			id: "insert-base",
			name: "Insert a table of notes linked to this note",
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				// Bases arrived in Obsidian 1.9.
				if (!file || !this.sides().size || !requireApiVersion("1.9.0")) return false;
				if (!checking) {
					new SidePickerModal(this, file, (side) => editor.replaceSelection(baseBlock(side)), "Choose which related notes to list").open();
				}
				return true;
			},
		});
		this.addCommand({
			id: "copy-base",
			name: "Copy a table of notes linked to this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !this.sides().size || !requireApiVersion("1.9.0")) return false;
				if (!checking) {
					new SidePickerModal(this, file, (side) => {
						void navigator.clipboard.writeText(baseBlock(side)).then(
							() => new Notice(`Copied a table of ${side.prop}. Paste it into any note.`),
							() => new Notice("Relate could not reach the clipboard.")
						);
					}, "Choose which related notes to list").open();
				}
				return true;
			},
		});
		this.addCommand({ id: "whats-new", name: "Show what's new", callback: () => this.showWhatsNew() });
		this.addCommand({ id: "find-relationships", name: "Find links in your vault", callback: () => new AdoptModal(this).open() });
		this.addCommand({ id: "check-links", name: "Check links", callback: () => new HealthModal(this).open() });
		this.addCommand({ id: "search-by-meaning", name: "Turn on search by meaning", callback: () => this.turnOnMeaning() });
		this.addCommand({
			id: "rebuild-meaning-index",
			name: "Rebuild the meaning index",
			checkCallback: (checking) => {
				if (!this.settings.semantic.enabled) return false;
				if (!checking) void this.semantic.rebuild();
				return true;
			},
		});

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
		this.addCommand({
			id: "undo",
			name: "Undo the last change",
			callback: async () => {
				const last = [...this.settings.history].reverse().find((b) => b.undoable);
				if (!last) {
					new Notice("Relate has no change to undo.");
					return;
				}
				await this.undoBatch(last.id);
			},
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
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
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
	 * device. Relate takes that copy, keeps history from both, and re-reads whatever the change affects, so its next
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

	/** Notes related to `path` through `prop`, whichever note records the link. */
	related(path: string, prop: string, all: boolean): Set<string> {
		return this.relatedDetail(path, prop, all).paths;
	}

	/**
	 * Notes related to `path` through `prop`. With `all`, follows chains only when the relationship allows it,
	 * and says whether it followed them and whether it stopped at the depth limit.
	 */
	relatedDetail(path: string, prop: string, all: boolean): { paths: Set<string>; followed: boolean; truncated: boolean } {
		const side = this.sides().get(prop);
		const step = (p: string) => {
			const out = new Set(this.index.targets(p, prop));
			if (side) for (const q of this.index.incoming(p, side.inverse)) out.add(q);
			out.delete(p);
			return out;
		};
		const follow = all && !!side?.chains;
		const r = traverse(path, step, follow, MAX_CHAIN_DEPTH);
		return { paths: r.paths, followed: follow, truncated: r.truncated };
	}

	/** Every note linked to `path` through any relationship. */
	connected(path: string): Set<string> {
		const out = new Set<string>();
		for (const side of this.sides().values()) {
			for (const p of this.index.targets(path, side.prop)) out.add(p);
			for (const p of this.index.incoming(path, side.prop)) out.add(p);
		}
		out.delete(path);
		return out;
	}

	// ----------------------------------------------------------------- releases

	/** Releases the Connections panel announces, newest first; empty once read or dismissed. */
	releaseNotes: ReleaseNote[] = [];

	/** The newest release seen: the later of the synced and this device's marker. */
	private seenVersion(): string {
		const local: unknown = this.app.loadLocalStorage(RELEASE_KEY);
		return laterVersion(this.settings.lastShownVersion, typeof local === "string" ? local : "");
	}

	private markReleaseSeen(): void {
		const current = this.manifest.version;
		const local: unknown = this.app.loadLocalStorage(RELEASE_KEY);
		this.app.saveLocalStorage(RELEASE_KEY, laterVersion(typeof local === "string" ? local : "", current));
		const synced = laterVersion(this.settings.lastShownVersion, current);
		if (synced === this.settings.lastShownVersion) return;
		this.settings.lastShownVersion = synced;
		void this.saveSettings();
	}

	/** At load: a new install is welcomed instead; an update queues its notes, unless announcements are off. */
	private reviewRelease(firstRun: boolean): void {
		const notes = firstRun || !this.settings.showReleaseNotes ? [] : unseenNotes(this.manifest.version, this.seenVersion());
		if (notes.length) this.releaseNotes = notes;
		else this.markReleaseSeen();
	}

	/** Opens the unseen notes, which closing marks read, or else the latest releases. */
	showWhatsNew(): void {
		const unseen = this.releaseNotes.length > 0;
		const notes = unseen ? this.releaseNotes : recentNotes(this.manifest.version);
		new WhatsNewModal(this, notes, unseen ? () => this.dismissReleaseNotes() : undefined).open();
	}

	dismissReleaseNotes(): void {
		if (!this.releaseNotes.length) return;
		this.releaseNotes = [];
		this.markReleaseSeen();
		this.refreshViews();
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

	/** Validated link changes for other plugins and scripts. */
	private async apiChange(from: string, property: string, to: string, add: boolean): Promise<{ ok: boolean; reason?: string }> {
		const side = this.sides().get(property);
		if (!side) return { ok: false, reason: `${property} is not a relationship Relate manages.` };
		const a = this.app.vault.getAbstractFileByPath(from);
		if (!(a instanceof TFile) || a.extension !== "md") return { ok: false, reason: `${from} is not a note.` };
		const b = this.app.vault.getAbstractFileByPath(to);
		if (a.path === to) return { ok: false, reason: "A note cannot be linked to itself." };
		let out;
		if (add) {
			if (!(b instanceof TFile) || b.extension !== "md") return { ok: false, reason: `${to} is not a note.` };
			out = await this.sync.connect(a, side, b);
		} else {
			out = await this.sync.disconnect(a, side, to);
		}
		if (out.error) return { ok: false, reason: out.error };
		if (!out.applied.length) return { ok: false, reason: out.skipped[0] ?? "Nothing changed." };
		this.refreshViews();
		return { ok: true };
	}

	async connect(file: TFile, side: Side, target: TFile): Promise<void> {
		const out = await this.sync.connect(file, side, target);
		this.sync.report(out, `Linked ${file.basename} and ${target.basename}.`);
	}

	record(label: string, ops: HistoryOp[], undoable: boolean): void {
		this.settings.history.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			time: Date.now(),
			label,
			ops: ops.slice(0, MAX_OPS_PER_BATCH),
			undoable: undoable && ops.length <= MAX_OPS_PER_BATCH,
		});
		if (this.settings.history.length > MAX_HISTORY) this.settings.history.splice(0, this.settings.history.length - MAX_HISTORY);
		void this.saveSettings();
	}

	/**
	 * Undoes a recorded batch. The batch is marked undone only when every change was reversed. Anything that could
	 * not be reversed stays in the batch, so the user can try again, and the notice says why.
	 */
	async undoBatch(id: string): Promise<void> {
		const batch = this.settings.history.find((b) => b.id === id);
		if (!batch || !batch.undoable) return;
		const label = batch.label.replace(/ \(partly undone\)$/, "");
		const result = await this.sync.undo(label, batch.ops);
		if (!result.unresolved.length) {
			batch.undoable = false;
			batch.label = `${label} (undone)`;
			new Notice(`Relate undid “${label}”.`);
		} else {
			batch.ops = result.unresolved;
			batch.label = `${label} (partly undone)`;
			const n = result.unresolved.length;
			new Notice(
				`Relate undid ${result.done} of ${result.done + n} changes in “${label}”. ${n === 1 ? "One change" : `${n} changes`} could not be undone: ${[...new Set(result.reasons)].join(" ")} ${n === 1 ? "It stays" : "They stay"} under Recent changes, so you can try again.`,
				12000
			);
		}
		await this.saveSettings();
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

	/** Turns on search by meaning, asking first when this device has no model yet. */
	turnOnMeaning(onCancel?: () => void): void {
		const begin = async () => {
			this.settings.semantic.enabled = true;
			await this.saveSettings();
			await this.semantic.start();
		};
		if (this.settings.semantic.source === "server") {
			// Turning it on here is this device agreeing to use the server.
			this.semantic.allowServer(this.settings.semantic.serverUrl.trim());
			void begin();
			return;
		}
		if (this.semantic.consented) {
			void begin();
			return;
		}
		new ConsentModal(
			this,
			async () => {
				this.settings.semantic.enabled = true;
				await this.saveSettings();
				try {
					await this.semantic.download();
				} catch (e) {
					const msg = this.reportError("Downloading the model", e);
					new Notice(`Relate could not download the model: ${msg}`, 10000);
					this.semantic.forgetConsent();
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
