import type { PackedModel } from "./static-model";

/** One note's vector, with what identifies the text it came from. */
export interface StoredVector {
	path: string;
	/** Fingerprint of the text the vector came from. */
	hash: string;
	model: string;
	vec: Float32Array;
	/** The note's modification time and size when it was read, so an unchanged note is not read again. */
	mtime?: number;
	size?: number;
}

/** Where the model and the note vectors live. On a device this is IndexedDB, outside the vault, so sync never copies it. */
export interface VectorStore {
	/** False when the store lives in memory only, so the model and vectors are gone when Obsidian closes. */
	readonly persistent: boolean;
	getModel(id: string): Promise<PackedModel | null>;
	putModel(m: PackedModel): Promise<void>;
	allVectors(): Promise<StoredVector[]>;
	putVectors(v: StoredVector[]): Promise<void>;
	deleteVectors(paths: string[]): Promise<void>;
	clear(): Promise<void>;
	close(): void;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error ?? new Error("The browser storage request failed."));
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("The browser storage transaction failed."));
		tx.onabort = () => reject(tx.error ?? new Error("The browser storage transaction was cancelled."));
	});
}

/** A vector store in this device's IndexedDB, outside the vault. */
export class IdbStore implements VectorStore {
	readonly persistent = true;

	private constructor(private db: IDBDatabase) {}

	/** Deletes the database called `name`. Close every connection to it first. */
	static destroy(name: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const r = indexedDB.deleteDatabase(name);
			r.onsuccess = () => resolve();
			// Another window still holds the database open; it goes once that window closes it.
			r.onblocked = () => resolve();
			r.onerror = () => reject(r.error ?? new Error("The browser storage could not delete Relate's index."));
		});
	}

	static async open(name: string): Promise<IdbStore> {
		const r = indexedDB.open(name, 1);
		r.onupgradeneeded = () => {
			const db = r.result;
			if (!db.objectStoreNames.contains("models")) db.createObjectStore("models", { keyPath: "id" });
			if (!db.objectStoreNames.contains("vectors")) db.createObjectStore("vectors", { keyPath: "path" });
		};
		return new IdbStore(await req(r));
	}

	async getModel(id: string): Promise<PackedModel | null> {
		const tx = this.db.transaction("models", "readonly");
		return ((await req(tx.objectStore("models").get(id))) as PackedModel | undefined) ?? null;
	}

	async putModel(m: PackedModel): Promise<void> {
		const tx = this.db.transaction("models", "readwrite");
		tx.objectStore("models").put(m);
		await done(tx);
	}

	async allVectors(): Promise<StoredVector[]> {
		const tx = this.db.transaction("vectors", "readonly");
		return (await req(tx.objectStore("vectors").getAll())) as StoredVector[];
	}

	async putVectors(v: StoredVector[]): Promise<void> {
		if (!v.length) return;
		const tx = this.db.transaction("vectors", "readwrite");
		const s = tx.objectStore("vectors");
		for (const x of v) s.put(x);
		await done(tx);
	}

	async deleteVectors(paths: string[]): Promise<void> {
		if (!paths.length) return;
		const tx = this.db.transaction("vectors", "readwrite");
		const s = tx.objectStore("vectors");
		for (const p of paths) s.delete(p);
		await done(tx);
	}

	async clear(): Promise<void> {
		const tx = this.db.transaction(["models", "vectors"], "readwrite");
		tx.objectStore("models").clear();
		tx.objectStore("vectors").clear();
		await done(tx);
	}

	close(): void {
		this.db.close();
	}
}

/** In-memory store for tests and for devices where IndexedDB is unavailable. */
export class MemoryStore implements VectorStore {
	readonly persistent = false;
	models = new Map<string, PackedModel>();
	vectors = new Map<string, StoredVector>();
	async getModel(id: string) {
		return this.models.get(id) ?? null;
	}
	async putModel(m: PackedModel) {
		this.models.set(m.id, m);
	}
	async allVectors() {
		return [...this.vectors.values()];
	}
	async putVectors(v: StoredVector[]) {
		for (const x of v) this.vectors.set(x.path, x);
	}
	async deleteVectors(paths: string[]) {
		for (const p of paths) this.vectors.delete(p);
	}
	async clear() {
		this.models.clear();
		this.vectors.clear();
	}
	close() {}
}
