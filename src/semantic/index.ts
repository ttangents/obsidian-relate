import { Notice, Platform, TFile, requestUrl, type App } from "obsidian";
import type { SemanticSettings } from "../settings";
import { BUILTIN, BuiltinEmbedder, ServerEmbedder, type Embedder } from "./embedders";
import { StaticModel } from "./static-model";
import { IdbStore, MemoryStore, type StoredVector, type VectorStore } from "./store";
import { fingerprint, rank, readableText, type Hit } from "./core";
import type { Consent } from "./consent";

export type SemanticState = "off" | "needs-download" | "needs-consent" | "downloading" | "preparing" | "indexing" | "ready" | "error";

export interface SemanticStatus {
	state: SemanticState;
	done: number;
	total: number;
	message: string;
}

/** Names this vault's index database on this device. */
const STORE_KEY = "relate-store-id";
const BATCH = 24;

/** A note's modification time and size, which change whenever its text does. */
function stamp(stat: { mtime: number; size: number }): string {
	return `${stat.mtime}:${stat.size}`;
}
const UPDATE_DELAY_MS = 2000;
/** Similar notes must score at least this, measured on real vaults with the built-in model. */
const SIMILAR_FLOOR = 0.45;

async function sha256(buf: ArrayBuffer): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", buf);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the meaning index needs from the plugin, and nothing more. */
export interface SemanticHost {
	app: App;
	settings: { semantic: SemanticSettings };
	/** Records an error and returns a plain message for the user. */
	reportError(where: string, e: unknown): string;
}

/** Keeps a vector for every note on this device and answers questions about meaning. */
export class SemanticIndex {
	status: SemanticStatus = { state: "off", done: 0, total: 0, message: "" };
	private store: VectorStore | null = null;
	private embedder: Embedder | null = null;
	private vectors = new Map<string, Float32Array>();
	private hashes = new Map<string, string>();
	/** Each note's modification time and size when its text was last read. */
	private stamps = new Map<string, string>();
	private timers = new Map<string, number>();
	private listeners = new Set<() => void>();
	private run = 0;

	/**
	 * `open` opens this vault's store on this device; tests pass their own. When it fails, the index falls back to a
	 * store in memory.
	 */
	constructor(
		private plugin: SemanticHost,
		private consent: Consent,
		private open: (name: string) => Promise<VectorStore> = (name) => IdbStore.open(name)
	) {}

	/** False when this device's browser storage failed to open, so the model cannot be kept between sessions. */
	get persistent(): boolean {
		return this.store?.persistent ?? true;
	}

	get ready(): boolean {
		return this.status.state === "ready" || (this.status.state === "indexing" && this.vectors.size > 0);
	}

	get count(): number {
		return this.vectors.size;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Goes up whenever what `similar` and `search` can return changes: the state, or any note's vector. */
	revision = 0;

	/** Tells listeners that vectors changed while the state stayed the same. */
	private touched(): void {
		this.revision++;
		for (const fn of this.listeners) fn();
	}

	private set(state: SemanticState, message = "", done = 0, total = 0): void {
		if (state !== this.status.state) this.revision++;
		this.status = { state, message, done, total };
		for (const fn of this.listeners) fn();
	}

	private get app() {
		return this.plugin.app;
	}

	private async openStore(): Promise<VectorStore> {
		if (this.store) return this.store;
		// Obsidian's local storage is kept per vault, so a random name stored there keeps vaults apart.
		let id: unknown = this.app.loadLocalStorage(STORE_KEY);
		if (typeof id !== "string" || !id) {
			id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
			this.app.saveLocalStorage(STORE_KEY, id);
		}
		try {
			this.store = await this.open(`relate-${String(id)}`);
		} catch (e) {
			this.plugin.reportError("Opening the meaning index", e);
			this.store = new MemoryStore();
		}
		return this.store;
	}

	/** Starts search by meaning if it is on. Never downloads without this device's consent. */
	async start(): Promise<void> {
		const s = this.plugin.settings.semantic;
		const myRun = ++this.run;
		this.vectors.clear();
		this.hashes.clear();
		this.stamps.clear();
		this.embedder = null;
		if (!s.enabled) {
			this.set("off");
			return;
		}
		try {
			const store = await this.openStore();
			if (s.source === "builtin") {
				const packed = await store.getModel(BUILTIN.id);
				if (!packed) {
					if (!store.persistent) {
						// The model would be gone when Obsidian closes, so each download needs its own yes.
						this.set("needs-download", `This device's browser storage is not available, so Relate cannot keep the ${BUILTIN.name} model between sessions. Download it for this session only to use search by meaning.`);
						return;
					}
					if (!this.consent.model) {
						this.set("needs-download", `Search by meaning needs the ${BUILTIN.name} model on this device (${BUILTIN.sizeLabel}).`);
						return;
					}
					try {
						await this.download();
					} catch (e) {
						// Ask again rather than download 30 MB on every start after a failure.
						this.consent.forgetModel();
						const msg = this.plugin.reportError("Downloading the model", e);
						if (myRun === this.run) this.set("needs-download", `The model download failed: ${msg}`);
						return;
					}
					if (myRun !== this.run) return;
					return this.start();
				}
				this.set("preparing", "Loading the model…");
				this.embedder = new BuiltinEmbedder(packed);
			} else {
				if (!s.serverUrl.trim() || !s.serverModel.trim()) {
					this.set("error", "Enter the server address and model name in Relate's settings.");
					return;
				}
				if (!this.consent.server(s.serverUrl)) {
					this.set("needs-consent", `Search by meaning sends the text of your notes to ${s.serverUrl.trim()}. This device has not agreed to that yet.`);
					return;
				}
				const key = s.secretId ? this.app.secretStorage?.getSecret(s.secretId) ?? null : null;
				this.embedder = new ServerEmbedder(s.serverUrl, s.serverModel, key, async (url, body, headers) => {
					const r = await requestUrl({ url, method: "POST", body, headers, throw: true });
					return r.json as unknown;
				});
			}
			for (const v of await store.allVectors()) {
				if (v.model !== this.embedder.id) continue;
				this.vectors.set(v.path, v.vec);
				this.hashes.set(v.path, v.hash);
				if (v.mtime !== undefined && v.size !== undefined) this.stamps.set(v.path, stamp({ mtime: v.mtime, size: v.size }));
			}
			if (myRun !== this.run) return;
			await this.indexAll(myRun);
		} catch (e) {
			if (myRun !== this.run) return;
			const msg = this.plugin.reportError("Search by meaning", e);
			this.set("error", `Search by meaning stopped: ${msg}`);
		}
	}

	/** Downloads the built-in model, checks it, and keeps an 8-bit copy on this device. */
	async download(): Promise<void> {
		this.consent.allowModel();
		this.set("downloading", `Downloading the ${BUILTIN.name} model (${BUILTIN.sizeLabel})…`);
		const files: Record<string, ArrayBuffer> = {};
		for (const [name, hash] of Object.entries(BUILTIN.files)) {
			const res = await requestUrl({ url: BUILTIN.url(name), throw: true });
			const buf = res.arrayBuffer;
			if ((await sha256(buf)) !== hash) throw new Error(`The downloaded ${name} does not match the published file. Nothing was saved.`);
			files[name] = buf;
		}
		this.set("preparing", "Preparing the model…");
		await new Promise((r) => window.setTimeout(r, 0));
		const tokenizer = JSON.parse(new TextDecoder().decode(files["tokenizer.json"])) as Parameters<typeof StaticModel.pack>[1];
		const packed = StaticModel.pack(BUILTIN.id, tokenizer, files["model.safetensors"]);
		await (await this.openStore()).putModel(packed);
	}

	private async noteText(file: TFile): Promise<string> {
		const raw = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const end = cache?.frontmatterPosition?.end.offset ?? 0;
		return readableText(file.basename, cache?.frontmatter, raw.slice(end));
	}

	/** Embeds every note whose text changed since it was last embedded. */
	private async indexAll(myRun: number): Promise<void> {
		const embedder = this.embedder;
		const store = this.store;
		if (!embedder || !store) return;
		const files = this.app.vault.getMarkdownFiles();
		const live = new Set(files.map((f) => f.path));
		const gone = [...this.vectors.keys()].filter((p) => !live.has(p));
		for (const p of gone) {
			this.vectors.delete(p);
			this.hashes.delete(p);
			this.stamps.delete(p);
		}
		await store.deleteVectors(gone);

		// Read only the notes whose modification time or size changed since their text was last read.
		const todo: { file: TFile; text: string; hash: string }[] = [];
		const restamped: StoredVector[] = [];
		for (const f of files) {
			if (this.hashes.has(f.path) && this.stamps.get(f.path) === stamp(f.stat)) continue;
			const text = await this.noteText(f);
			const hash = fingerprint(text);
			if (this.hashes.get(f.path) !== hash) {
				todo.push({ file: f, text, hash });
				continue;
			}
			// Same text, new stamp: remember the stamp, so the next start skips the note.
			this.stamps.set(f.path, stamp(f.stat));
			const vec = this.vectors.get(f.path);
			if (vec) restamped.push({ path: f.path, hash, model: embedder.id, vec, mtime: f.stat.mtime, size: f.stat.size });
		}
		await store.putVectors(restamped);
		if (!todo.length) {
			this.set("ready");
			return;
		}
		this.set("indexing", "", 0, todo.length);
		for (let i = 0; i < todo.length; i += BATCH) {
			if (myRun !== this.run) return;
			const batch = todo.slice(i, i + BATCH);
			const vecs = await embedder.embed(batch.map((b) => b.text));
			const rows: StoredVector[] = [];
			batch.forEach((b, j) => {
				const vec = vecs[j];
				this.hashes.set(b.file.path, b.hash);
				this.stamps.set(b.file.path, stamp(b.file.stat));
				if (vec) {
					this.vectors.set(b.file.path, vec);
					rows.push({ path: b.file.path, hash: b.hash, model: embedder.id, vec, mtime: b.file.stat.mtime, size: b.file.stat.size });
				} else {
					this.vectors.delete(b.file.path);
				}
			});
			await store.putVectors(rows);
			this.revision++;
			this.set("indexing", "", Math.min(i + BATCH, todo.length), todo.length);
			await new Promise((r) => window.setTimeout(r, Platform.isMobile ? 30 : 0));
		}
		if (myRun === this.run) this.set("ready");
	}

	/** Re-embeds one note a moment after its last change. */
	onModify(file: TFile): void {
		if (!this.embedder || file.extension !== "md") return;
		const old = this.timers.get(file.path);
		if (old !== undefined) window.clearTimeout(old);
		this.timers.set(
			file.path,
			window.setTimeout(async () => {
				this.timers.delete(file.path);
				const embedder = this.embedder;
				if (!embedder || !this.store) return;
				try {
					const store = this.store;
					const text = await this.noteText(file);
					const hash = fingerprint(text);
					const { mtime, size } = file.stat;
					this.stamps.set(file.path, stamp(file.stat));
					if (this.hashes.get(file.path) === hash) {
						const vec = this.vectors.get(file.path);
						if (vec) await store.putVectors([{ path: file.path, hash, model: embedder.id, vec, mtime, size }]);
						return;
					}
					const [vec] = await embedder.embed([text]);
					this.hashes.set(file.path, hash);
					if (vec) {
						this.vectors.set(file.path, vec);
						this.touched();
						await store.putVectors([{ path: file.path, hash, model: embedder.id, vec, mtime, size }]);
					}
				} catch (e) {
					this.plugin.reportError("Updating the meaning index", e);
				}
			}, UPDATE_DELAY_MS)
		);
	}

	onRename(oldPath: string, file: TFile): void {
		const vec = this.vectors.get(oldPath);
		const hash = this.hashes.get(oldPath);
		this.vectors.delete(oldPath);
		this.hashes.delete(oldPath);
		this.stamps.delete(oldPath);
		if (!vec || !hash || !this.store || !this.embedder) return;
		this.vectors.set(file.path, vec);
		this.hashes.set(file.path, hash);
		this.touched();
		const store = this.store;
		const model = this.embedder.id;
		store
			.deleteVectors([oldPath])
			.then(() => store.putVectors([{ path: file.path, hash, model, vec }]))
			.catch((e) => {
				// After stop() closes the store, a rename still in flight has nothing left to update.
				if (this.store === store) this.plugin.reportError("Moving a note in the meaning index", e);
			});
		// The title is part of the text, so the vector is refreshed too.
		this.onModify(file);
	}

	onDelete(path: string): void {
		if (this.vectors.delete(path)) this.touched();
		this.hashes.delete(path);
		this.stamps.delete(path);
		const store = this.store;
		store?.deleteVectors([path]).catch((e) => {
			if (this.store === store) this.plugin.reportError("Removing a note from the meaning index", e);
		});
	}

	/** Notes closest in meaning to `text`, optionally only among `within`. */
	async search(text: string, within: Set<string> | null, limit = 20): Promise<Hit[]> {
		if (!this.ready || !this.embedder) return [];
		const [q] = await this.embedder.embed([text]);
		if (!q) return [];
		return rank(q, this.vectors, within, limit, 0.1, 0.6);
	}

	/** Notes closest in meaning to the note at `path`, at most `limit`, which is kept between 1 and 50. */
	similar(path: string, limit = 5): Hit[] {
		limit = Math.max(1, Math.min(50, Math.floor(limit) || 5));
		const v = this.vectors.get(path);
		if (!v) return [];
		return rank(v, this.vectors, null, limit + 1, SIMILAR_FLOOR, 0).filter((h) => h.path !== path).slice(0, limit);
	}

	async rebuild(): Promise<void> {
		const store = await this.openStore();
		await store.deleteVectors((await store.allVectors()).map((v) => v.path));
		await this.start();
	}

	/** Deletes the model and every vector from this device. */
	async remove(): Promise<void> {
		this.run++;
		this.vectors.clear();
		this.hashes.clear();
		this.stamps.clear();
		this.embedder = null;
		await (await this.openStore()).clear();
		this.consent.forgetModel();
		this.set("off");
		new Notice("Relate removed the model and the meaning index from this device.");
	}

	stop(): void {
		this.run++;
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
		this.store?.close();
		this.store = null;
		this.listeners.clear();
	}
}
