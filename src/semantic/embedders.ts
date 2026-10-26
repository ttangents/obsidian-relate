import { StaticModel, type PackedModel } from "./static-model";
import { unit } from "./core";

/** Turns texts into unit vectors. A null vector means the text had nothing to embed. */
export interface Embedder {
	/** Identifies the model, so vectors from different models are never mixed. */
	readonly id: string;
	embed(texts: string[]): Promise<(Float32Array | null)[]>;
}

/** The built-in model, pinned to one published revision and checked against its known fingerprint. */
export const BUILTIN = {
	name: "potion-base-8M",
	repo: "minishlab/potion-base-8M",
	revision: "bf8b056651a2c21b8d2565580b8569da283cab23",
	files: {
		"tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
		"model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
	},
	sizeLabel: "30 MB",
	license: "MIT",
	get id() {
		return `${this.name}@${this.revision.slice(0, 7)}`;
	},
	url(file: string) {
		return `https://huggingface.co/${this.repo}/resolve/${this.revision}/${file}`;
	},
};

/** The built-in static model, run in plain JavaScript on this device. */
export class BuiltinEmbedder implements Embedder {
	readonly id: string;
	private model: StaticModel;

	constructor(packed: PackedModel) {
		this.id = packed.id;
		this.model = StaticModel.unpack(packed);
	}

	async embed(texts: string[]): Promise<(Float32Array | null)[]> {
		return texts.map((t) => this.model.encode(t));
	}
}

/** Sends a JSON body to a URL and returns the parsed reply; Obsidian's requestUrl in the plugin, a fake in tests. */
export type Fetcher = (url: string, body: string, headers: Record<string, string>) => Promise<unknown>;

/** Any server with an OpenAI-compatible embeddings endpoint, such as Ollama or LM Studio. */
export class ServerEmbedder implements Embedder {
	readonly id: string;
	private endpoint: string;

	constructor(url: string, private model: string, private key: string | null, private fetcher: Fetcher) {
		const base = url.trim().replace(/\/+$/, "");
		this.endpoint = /\/embeddings$/.test(base) ? base : /\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
		this.id = `server:${model}@${base}`;
	}

	async embed(texts: string[]): Promise<(Float32Array | null)[]> {
		const out: (Float32Array | null)[] = [];
		for (let i = 0; i < texts.length; i += 16) {
			const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 8000));
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (this.key) headers.Authorization = `Bearer ${this.key}`;
			const res = (await this.fetcher(this.endpoint, JSON.stringify({ model: this.model, input: batch }), headers)) as {
				data?: { index?: number; embedding: number[] }[];
			};
			if (!res?.data || res.data.length !== batch.length) throw new Error("The server's reply did not contain one embedding per note.");
			const sorted = [...res.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			for (const d of sorted) out.push(d.embedding?.length ? unit(Float32Array.from(d.embedding)) : null);
		}
		return out;
	}
}
