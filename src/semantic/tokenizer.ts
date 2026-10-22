/**
 * BERT WordPiece tokenizer, matching the Hugging Face `tokenizers` pipeline used by potion models:
 * BertNormalizer (clean text, space around CJK characters, strip accents, lowercase),
 * BertPreTokenizer (split on whitespace and punctuation), then greedy longest-match WordPiece.
 */

const CJK: [number, number][] = [
	[0x4e00, 0x9fff],
	[0x3400, 0x4dbf],
	[0x20000, 0x2a6df],
	[0x2a700, 0x2b73f],
	[0x2b740, 0x2b81f],
	[0x2b920, 0x2ceaf],
	[0xf900, 0xfaff],
	[0x2f800, 0x2fa1f],
];

function isCjk(cp: number): boolean {
	for (const [a, b] of CJK) if (cp >= a && cp <= b) return true;
	return false;
}

const CONTROL = /\p{C}/u;
const WHITESPACE = /\s/u;
const PUNCT = /\p{P}/u;
const MARK = /\p{Mn}/u;

function isAsciiPunct(cp: number): boolean {
	return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
}

export function normalize(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) as number;
		if (ch === "\t" || ch === "\n" || ch === "\r") {
			out += " ";
			continue;
		}
		if (cp === 0 || cp === 0xfffd || CONTROL.test(ch)) continue;
		if (WHITESPACE.test(ch)) {
			out += " ";
			continue;
		}
		out += isCjk(cp) ? ` ${ch} ` : ch;
	}
	let stripped = "";
	for (const ch of out.normalize("NFD")) if (!MARK.test(ch)) stripped += ch;
	return stripped.toLowerCase();
}

export function preTokenize(text: string): string[] {
	const words: string[] = [];
	let cur = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) as number;
		if (WHITESPACE.test(ch)) {
			if (cur) words.push(cur);
			cur = "";
		} else if (isAsciiPunct(cp) || PUNCT.test(ch)) {
			if (cur) words.push(cur);
			words.push(ch);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur) words.push(cur);
	return words;
}

export class WordPieceTokenizer {
	readonly unkId: number;

	constructor(
		private vocab: Map<string, number>,
		unkToken = "[UNK]",
		private prefix = "##",
		private maxChars = 100
	) {
		this.unkId = vocab.get(unkToken) ?? -1;
	}

	/** Builds a tokenizer from a Hugging Face tokenizer.json. */
	static fromJson(json: { model: { type: string; vocab: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number } }): WordPieceTokenizer {
		const m = json.model;
		if (m.type !== "WordPiece") throw new Error(`Unsupported tokenizer type: ${m.type}`);
		return new WordPieceTokenizer(new Map(Object.entries(m.vocab)), m.unk_token ?? "[UNK]", m.continuing_subword_prefix ?? "##", m.max_input_chars_per_word ?? 100);
	}

	/** The vocabulary ordered by id, for compact storage. */
	vocabList(): string[] {
		const list: string[] = [];
		for (const [tok, id] of this.vocab) list[id] = tok;
		return list;
	}

	static fromList(list: string[], unkToken = "[UNK]"): WordPieceTokenizer {
		const vocab = new Map<string, number>();
		list.forEach((tok, id) => vocab.set(tok, id));
		return new WordPieceTokenizer(vocab, unkToken);
	}

	/** Token ids without special tokens. Stops after `limit` ids. */
	encode(text: string, limit = Infinity): number[] {
		const ids: number[] = [];
		for (const word of preTokenize(normalize(text))) {
			for (const id of this.word(word)) {
				ids.push(id);
				if (ids.length >= limit) return ids;
			}
		}
		return ids;
	}

	private word(word: string): number[] {
		const chars = [...word];
		if (chars.length > this.maxChars) return [this.unkId];
		const out: number[] = [];
		let start = 0;
		while (start < chars.length) {
			let end = chars.length;
			let found = -1;
			while (start < end) {
				let piece = chars.slice(start, end).join("");
				if (start > 0) piece = this.prefix + piece;
				const id = this.vocab.get(piece);
				if (id !== undefined) {
					found = id;
					break;
				}
				end--;
			}
			if (found < 0) return [this.unkId];
			out.push(found);
			start = end;
		}
		return out;
	}
}
