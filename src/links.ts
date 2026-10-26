/** "3 notes", "1 note": a count with the word that fits it. */
export function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** A note's name from its path: "Projects/Atlas.md" -> "Atlas". */
export function basename(path: string): string {
	return path.replace(/^.*\//, "").replace(/\.md$/, "");
}

/** Returns the link path inside a frontmatter wikilink string such as "[[Note|Alias]]", or null. */
export function parseWikilink(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const m = value.trim().match(/^!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]$/);
	return m ? m[1].trim() : null;
}

export function toArray(value: unknown): unknown[] {
	if (value === null || value === undefined || value === "") return [];
	return Array.isArray(value) ? value : [value];
}

/** Human label for a property name: "part_of" -> "part of". */
export function labelOf(prop: string): string {
	return prop.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Lowercase, punctuation stripped, spaces collapsed. Used to match note titles typed in search. */
export function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Title with a leading bracketed tag removed: "(Project) Atlas" -> "Atlas". */
export function stripLeadingTag(title: string): string {
	return title.replace(/^\s*[([{][^)\]}]*[)\]}]\s*/, "").trim();
}

/** Does `frontmatterLinks[].key` belong to property `prop`? Keys look like "parent" or "children.2". */
export function keyBelongsTo(key: string, prop: string): boolean {
	return key === prop || (key.startsWith(prop + ".") && /^\d+$/.test(key.slice(prop.length + 1)));
}

/**
 * Returns a function that names notes by title, adding the folder when two notes share a title,
 * so "Notes (Projects/Atlas)" and "Notes (Projects/Orion)" stay distinguishable.
 */
export function noteNamer(paths: Iterable<string>): (path: string) => string {
	const counts = new Map<string, number>();
	for (const p of paths) counts.set(basename(p), (counts.get(basename(p)) ?? 0) + 1);
	return (p: string) => {
		const b = basename(p);
		if ((counts.get(b) ?? 0) < 2) return b;
		const folder = p.includes("/") ? p.replace(/\/[^/]*$/, "") : "vault root";
		return `${b} (${folder})`;
	};
}
