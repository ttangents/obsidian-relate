import { dot } from "./static-model";

export interface Hit {
	path: string;
	score: number;
}

/** Turns a vector of any length into a unit vector, in place. */
export function unit(v: Float32Array): Float32Array {
	let n = 0;
	for (let i = 0; i < v.length; i++) n += v[i] * v[i];
	n = Math.sqrt(n) || 1;
	for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

/** Short, stable fingerprint of a note's text, used to skip notes that have not changed. */
export function fingerprint(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995);
	}
	return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + text.length.toString(36);
}

/** An ISO-style date or date and time, such as 2026-10-22T07:51:00+08:00. */
const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Note text as the model should read it: title, descriptive properties and body, without markup. */
export function readableText(title: string, frontmatter: Record<string, unknown> | undefined, body: string): string {
	const props: string[] = [];
	for (const [k, v] of Object.entries(frontmatter ?? {})) {
		if (k === "aliases" && Array.isArray(v)) props.push(...v.filter((x): x is string => typeof x === "string"));
		// Dates are left out: they carry no meaning, and a linter or sync tool that re-stamps them would
		// otherwise make an unchanged note look changed and be embedded again.
		else if (typeof v === "string" && v.length > 20 && !v.startsWith("[[") && !/^https?:/.test(v) && !DATE.test(v.trim())) props.push(v);
	}
	const clean = body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[\[[^\]]*\]\]/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^\s*(#+|[-*+]|\d+\.)\s+(\[.\]\s+)?/gm, "")
		.replace(/[*_`>~=]+/g, " ");
	return [title, ...props, clean].join("\n");
}

/** Ranks candidate notes by closeness to `query`. Keeps hits close to the best one, so weak matches drop out. */
export function rank(query: Float32Array, vectors: Map<string, Float32Array>, within: Iterable<string> | null, limit: number, floor: number, relative: number): Hit[] {
	const hits: Hit[] = [];
	const pool = within ?? vectors.keys();
	for (const path of pool) {
		const v = vectors.get(path);
		if (!v || v.length !== query.length) continue;
		hits.push({ path, score: dot(query, v) });
	}
	hits.sort((a, b) => b.score - a.score);
	const top = hits[0]?.score ?? 0;
	const cut = Math.max(floor, top * relative);
	return hits.filter((h) => h.score >= cut).slice(0, limit);
}

/** Reciprocal rank fusion: merges ranked lists so a note ranked well in either list rises. */
export function fuse(lists: string[][], k = 60): Map<string, number> {
	const out = new Map<string, number>();
	for (const list of lists) list.forEach((p, i) => out.set(p, (out.get(p) ?? 0) + 1 / (k + i + 1)));
	return out;
}
