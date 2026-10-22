import { WordPieceTokenizer } from "./tokenizer";

/** Reads a safetensors file and returns its first 2-D float tensor. */
export function readSafetensors(buffer: ArrayBuffer): { rows: number; dim: number; data: Float32Array } {
	const view = new DataView(buffer);
	const headerLen = Number(view.getBigUint64(0, true));
	const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen))) as Record<
		string,
		{ dtype: string; shape: number[]; data_offsets: [number, number] }
	>;
	const entry = header.embeddings ?? Object.entries(header).find(([k]) => k !== "__metadata__")?.[1];
	if (!entry || entry.shape.length !== 2) throw new Error("The model file has no embedding table.");
	const [rows, dim] = entry.shape;
	const start = 8 + headerLen + entry.data_offsets[0];
	const count = rows * dim;
	if (entry.dtype === "F32") {
		return { rows, dim, data: new Float32Array(buffer.slice(start, start + count * 4)) };
	}
	if (entry.dtype === "F16") {
		const half = new Uint16Array(buffer.slice(start, start + count * 2));
		const data = new Float32Array(count);
		for (let i = 0; i < count; i++) data[i] = halfToFloat(half[i]);
		return { rows, dim, data };
	}
	throw new Error(`Unsupported model number format: ${entry.dtype}`);
}

function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
	if (e === 31) return f ? NaN : s * Infinity;
	return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** What Relate keeps on the device: the vocabulary and an 8-bit copy of the embedding table. */
export interface PackedModel {
	id: string;
	dim: number;
	vocab: string[];
	q: ArrayBuffer;
	scales: ArrayBuffer;
}

/**
 * A static embedding model (Model2Vec): a sentence vector is the normalised mean of its token vectors.
 * The table is held as 8-bit integers with one scale per row, a quarter of the original size.
 */
export class StaticModel {
	private q: Int8Array;
	private scales: Float32Array;

	constructor(
		readonly id: string,
		private tokenizer: WordPieceTokenizer,
		readonly dim: number,
		q: ArrayBuffer,
		scales: ArrayBuffer
	) {
		this.q = new Int8Array(q);
		this.scales = new Float32Array(scales);
	}

	static pack(id: string, tokenizerJson: Parameters<typeof WordPieceTokenizer.fromJson>[0], safetensors: ArrayBuffer): PackedModel {
		const tokenizer = WordPieceTokenizer.fromJson(tokenizerJson);
		const { rows, dim, data } = readSafetensors(safetensors);
		const q = new Int8Array(rows * dim);
		const scales = new Float32Array(rows);
		for (let r = 0; r < rows; r++) {
			let max = 0;
			for (let c = 0; c < dim; c++) max = Math.max(max, Math.abs(data[r * dim + c]));
			const scale = max / 127 || 1;
			scales[r] = scale;
			for (let c = 0; c < dim; c++) q[r * dim + c] = Math.round(data[r * dim + c] / scale);
		}
		return { id, dim, vocab: tokenizer.vocabList(), q: q.buffer, scales: scales.buffer };
	}

	static unpack(p: PackedModel): StaticModel {
		return new StaticModel(p.id, WordPieceTokenizer.fromList(p.vocab), p.dim, p.q, p.scales);
	}

	/** A unit-length vector for `text`, or null when the text has no known words. */
	encode(text: string, maxTokens = 2048): Float32Array | null {
		const ids = this.tokenizer.encode(text, maxTokens * 2).filter((id) => id !== this.tokenizer.unkId).slice(0, maxTokens);
		if (!ids.length) return null;
		const dim = this.dim;
		const out = new Float32Array(dim);
		for (const id of ids) {
			const s = this.scales[id];
			const base = id * dim;
			for (let c = 0; c < dim; c++) out[c] += this.q[base + c] * s;
		}
		let norm = 0;
		for (let c = 0; c < dim; c++) norm += out[c] * out[c];
		norm = Math.sqrt(norm) || 1;
		for (let c = 0; c < dim; c++) out[c] /= norm;
		return out;
	}
}

export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}
