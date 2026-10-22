import { findDate } from "./dates";

export interface NoteRef {
	path: string;
	title: string;
}

/** Turns a span of typed text into a note, or null when no note fits. */
export type Resolver = (span: string) => NoteRef | null;

export interface ChainStep {
	prop: string;
	label: string;
	all: boolean;
}

export interface RelationChip {
	kind: "relation";
	prop: string;
	label: string;
	note: NoteRef;
	all: boolean;
	/** For nested phrases such as "residents of all places of Gondor": every step, outermost first. */
	chain: ChainStep[];
	start: number;
	end: number;
}
export interface ConnectedChip {
	kind: "connected";
	note: NoteRef;
	start: number;
	end: number;
}
export interface DateChip {
	kind: "date";
	from: number;
	to: number;
	label: string;
	start: number;
	end: number;
}
/** Notes with no link under a relationship property: "without project". */
export interface MissingChip {
	kind: "missing";
	prop: string;
	/** As shown and as written back into the query: "without project". */
	label: string;
	start: number;
	end: number;
}
/** Notes in a folder or below it: "in Research/Notes". */
export interface FolderChip {
	kind: "folder";
	path: string;
	label: string;
	start: number;
	end: number;
}
/** Notes with a tag or a tag nested under it: "#draft". */
export interface TagChip {
	kind: "tag";
	tag: string;
	label: string;
	start: number;
	end: number;
}
export type Chip = RelationChip | ConnectedChip | DateChip | MissingChip | FolderChip | TagChip;

/** Turns typed text into a folder path, or null when no folder fits. */
export type FolderResolver = (span: string) => string | null;

export interface ParsedQuery {
	chips: Chip[];
	text: string;
}

const MAX_TITLE_WORDS = 10;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word spans in `text` from `from` onward: [start, end] pairs. */
function wordsAfter(text: string, from: number): [number, number][] {
	const out: [number, number][] = [];
	const re = /\S+/g;
	re.lastIndex = from;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) && out.length < MAX_TITLE_WORDS) out.push([m.index, m.index + m[0].length]);
	return out;
}

/** Longest run of words starting at `from` that resolves to a note. */
function noteAfter(text: string, from: number, resolve: Resolver): { note: NoteRef; end: number } | null {
	const words = wordsAfter(text, from);
	for (let n = words.length; n >= 1; n--) {
		const end = words[n - 1][1];
		const span = text.slice(words[0][0], end).replace(/[?.!,;]+$/, "");
		const note = resolve(span);
		if (note) return { note, end: words[0][0] + span.length };
	}
	return null;
}

/** Longest run of words ending at `to` that resolves to a note. */
function noteBefore(text: string, to: number, resolve: Resolver): { note: NoteRef; start: number } | null {
	const words: [number, number][] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	const head = text.slice(0, to);
	while ((m = re.exec(head))) words.push([m.index, m.index + m[0].length]);
	const tail = words.slice(-MAX_TITLE_WORDS);
	for (let i = 0; i < tail.length; i++) {
		const start = tail[i][0];
		const note = resolve(text.slice(start, to));
		if (note) return { note, start };
	}
	return null;
}

function blank(text: string, start: number, end: number): string {
	return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

/**
 * Reads relationship and date phrases out of a search query.
 * `labels` maps lowercase relationship labels ("children", "part of") to property names.
 * Chip positions refer to the original query, so the interface can remove a chip by cutting its span.
 */
export function parseQuery(
	query: string,
	labels: Map<string, string>,
	resolve: Resolver,
	now: Date = new Date(),
	folder: FolderResolver = () => null
): ParsedQuery {
	const chips: Chip[] = [];
	let work = query;

	if (labels.size) {
		const alt = [...labels.keys()]
			.sort((a, b) => b.length - a.length)
			.map((l) => escapeRe(l).replace(/\\? /g, "[\\s_-]+"))
			.join("|");
		const ofRe = new RegExp(`\\b(all\\s+)?(${alt})\\s+of\\s+`, "gi");
		const possRe = new RegExp(`['’]s\\s+(all\\s+)?(${alt})\\b`, "gi");
		const colonRe = new RegExp(`\\b(${alt}):\\s*`, "gi");
		const labelFor = (s: string) => labels.get(s.toLowerCase().replace(/[\s_-]+/g, " ")) ?? "";

		for (let guard = 0; guard < 6; guard++) {
			let found = false;

			ofRe.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = ofRe.exec(work))) {
				// Gather nested steps: "residents of all places of Gondor".
				const chain: ChainStep[] = [{ prop: labelFor(m[2]), label: m[2].toLowerCase(), all: !!m[1] }];
				let pos = m.index + m[0].length;
				const innerRe = new RegExp(`^(all\\s+)?(${alt})\\s+of\\s+`, "i");
				for (let k = 0; k < 4; k++) {
					const inner = work.slice(pos).match(innerRe);
					if (!inner) break;
					chain.push({ prop: labelFor(inner[2]), label: inner[2].toLowerCase(), all: !!inner[1] });
					pos += inner[0].length;
				}
				const hit = noteAfter(work, pos, resolve);
				if (!hit) continue;
				const prop = chain[0].prop;
				chips.push({ kind: "relation", prop, label: chain[0].label, note: hit.note, all: chain[0].all, chain, start: m.index, end: hit.end });
				work = blank(work, m.index, hit.end);
				found = true;
				break;
			}
			if (found) continue;

			possRe.lastIndex = 0;
			while ((m = possRe.exec(work))) {
				const hit = noteBefore(work, m.index, resolve);
				if (!hit) continue;
				const prop = labelFor(m[2]);
				const end = m.index + m[0].length;
				chips.push({ kind: "relation", prop, label: m[2].toLowerCase(), note: hit.note, all: !!m[1], chain: [{ prop, label: m[2].toLowerCase(), all: !!m[1] }], start: hit.start, end });
				work = blank(work, hit.start, end);
				found = true;
				break;
			}
			if (found) continue;

			colonRe.lastIndex = 0;
			while ((m = colonRe.exec(work))) {
				const hit = noteAfter(work, m.index + m[0].length, resolve);
				if (!hit) continue;
				const prop = labelFor(m[1]);
				chips.push({ kind: "relation", prop, label: m[1].toLowerCase(), note: hit.note, all: false, chain: [{ prop, label: m[1].toLowerCase(), all: false }], start: m.index, end: hit.end });
				work = blank(work, m.index, hit.end);
				found = true;
				break;
			}
			if (!found) break;
		}
	}

	const connRe = /\b(?:connected|linked)\s+to\s+/gi;
	let cm: RegExpExecArray | null;
	while ((cm = connRe.exec(work))) {
		const hit = noteAfter(work, cm.index + cm[0].length, resolve);
		if (!hit) continue;
		chips.push({ kind: "connected", note: hit.note, start: cm.index, end: hit.end });
		work = blank(work, cm.index, hit.end);
		connRe.lastIndex = 0;
	}

	if (labels.size) {
		const alt = [...labels.keys()]
			.sort((a, b) => b.length - a.length)
			.map((l) => escapeRe(l).replace(/\\? /g, "[\\s_-]+"))
			.join("|");
		const missRe = new RegExp(`\\b(?:without|missing|no)\\s+(?:any\\s+)?(${alt})\\b`, "gi");
		let mm: RegExpExecArray | null;
		while ((mm = missRe.exec(work))) {
			const prop = labels.get(mm[1].toLowerCase().replace(/[\s_-]+/g, " ")) ?? "";
			const end = mm.index + mm[0].length;
			chips.push({ kind: "missing", prop, label: `without ${mm[1].toLowerCase()}`, start: mm.index, end });
			work = blank(work, mm.index, end);
			missRe.lastIndex = 0;
		}
	}

	const date = findDate(work, now);
	if (date) {
		chips.push({ kind: "date", ...date });
		work = blank(work, date.start, date.end);
	}

	// "in Research/Notes": after dates, so "in 2023" stays a date.
	const inRe = /\bin\s+/gi;
	let im: RegExpExecArray | null;
	while ((im = inRe.exec(work))) {
		const words = wordsAfter(work, im.index + im[0].length);
		let found = false;
		for (let n = words.length; n >= 1; n--) {
			const end = words[n - 1][1];
			const span = work.slice(words[0][0], end).replace(/[?.!,;]+$/, "");
			const path = folder(span);
			if (path === null) continue;
			const stop = words[0][0] + span.length;
			chips.push({ kind: "folder", path, label: `in ${path}`, start: im.index, end: stop });
			work = blank(work, im.index, stop);
			found = true;
			break;
		}
		if (found) inRe.lastIndex = 0;
	}

	const tagRe = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
	let tm: RegExpExecArray | null;
	while ((tm = tagRe.exec(work))) {
		const start = tm.index + tm[1].length;
		const end = start + 1 + tm[2].length;
		chips.push({ kind: "tag", tag: tm[2], label: `#${tm[2]}`, start, end });
		work = blank(work, start, end);
		tagRe.lastIndex = 0;
	}

	chips.sort((a, b) => a.start - b.start);
	return { chips, text: work.replace(/\s+/g, " ").trim() };
}

/** The query with one chip's text cut out. */
export function removeChip(query: string, chip: Chip): string {
	return (query.slice(0, chip.start) + " " + query.slice(chip.end)).replace(/\s+/g, " ").trim();
}

/** The text a chip stands for, so a changed chip can be written back into the query. */
export function chipToText(chip: Chip): string {
	if (chip.kind === "relation") return chip.chain.map((c) => `${c.all ? "all " : ""}${c.label} of `).join("") + chip.note.title;
	if (chip.kind === "connected") return `connected to ${chip.note.title}`;
	return chip.label;
}

/** The query with one chip replaced by new text. */
export function replaceChip(query: string, chip: Chip, text: string): string {
	return (query.slice(0, chip.start) + text + query.slice(chip.end)).replace(/\s+/g, " ").trim();
}
