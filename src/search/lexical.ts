const STOP = new Set(
	"a an and are as at be but by for from has have i in into is it its of on or that the this to was were will with about notes note".split(" ")
);

export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
		const t = m[0];
		if (t.length > 1 && !STOP.has(t)) out.push(t);
	}
	return out;
}

interface Doc {
	len: number;
	tf: Map<string, number>;
}

export interface LexicalHit {
	path: string;
	score: number;
	matched: string[];
}

const TITLE_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;

/** In-memory BM25 index over note titles and bodies. */
export class LexicalIndex {
	private docs = new Map<string, Doc>();
	private df = new Map<string, number>();
	private totalLen = 0;

	get size(): number {
		return this.docs.size;
	}

	set(path: string, title: string, body: string): void {
		this.remove(path);
		const tf = new Map<string, number>();
		let len = 0;
		for (const t of tokenize(title)) {
			tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
			len += TITLE_WEIGHT;
		}
		for (const t of tokenize(body)) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
			len += 1;
		}
		for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
		this.docs.set(path, { len, tf });
		this.totalLen += len;
	}

	remove(path: string): void {
		const doc = this.docs.get(path);
		if (!doc) return;
		for (const t of doc.tf.keys()) {
			const n = (this.df.get(t) ?? 1) - 1;
			if (n <= 0) this.df.delete(t);
			else this.df.set(t, n);
		}
		this.totalLen -= doc.len;
		this.docs.delete(path);
	}

	rename(oldPath: string, newPath: string): void {
		const doc = this.docs.get(oldPath);
		if (!doc) return;
		this.docs.delete(oldPath);
		this.docs.set(newPath, doc);
	}

	/** Expands the last query term to indexed words that start with it, so results appear while typing. */
	private expand(terms: string[]): string[][] {
		return terms.map((t, i) => {
			if (this.df.has(t) || i !== terms.length - 1 || t.length < 2) return [t];
			const out: string[] = [];
			for (const w of this.df.keys()) {
				if (w.startsWith(t)) {
					out.push(w);
					if (out.length >= 30) break;
				}
			}
			return out.length ? out : [t];
		});
	}

	search(query: string, within: Set<string> | null, limit = 50): LexicalHit[] {
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !this.docs.size) return [];
		const groups = this.expand(terms);
		const n = this.docs.size;
		const avg = this.totalLen / n || 1;
		const hits: LexicalHit[] = [];
		const paths = within ?? this.docs.keys();
		for (const path of paths) {
			const doc = this.docs.get(path);
			if (!doc) continue;
			let score = 0;
			const matched: string[] = [];
			let groupsHit = 0;
			for (const group of groups) {
				let best = 0;
				let bestWord = "";
				for (const w of group) {
					const f = doc.tf.get(w);
					if (!f) continue;
					const df = this.df.get(w) ?? 0;
					const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
					const s = (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avg));
					if (s > best) {
						best = s;
						bestWord = w;
					}
				}
				if (best > 0) {
					score += best;
					matched.push(bestWord);
					groupsHit++;
				}
			}
			if (!groupsHit) continue;
			// Prefer notes that match every term.
			score *= 0.5 + (0.5 * groupsHit) / groups.length;
			hits.push({ path, score, matched });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
}
