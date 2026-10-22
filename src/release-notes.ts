/**
 * Release notes, and when Relate announces them.
 *
 * A new install shows the welcome window once and announces nothing. After an update, the Connections panel shows
 * a one-line notice that opens the notes for the releases the reader has not seen. The newest release seen is kept
 * twice: in Relate's settings, so reading the notes on one device clears the notice on every device that syncs, and
 * in this device's local storage, so an older settings file arriving by sync cannot bring the notice back. The later
 * of the two wins.
 *
 * Writing a release: newest first, with a version that matches manifest.json. Items are plain sentences about what
 * changed and where to find it. A release of small fixes sets `announce: false`; its notes still show in the window.
 */

export interface ReleaseNote {
	version: string;
	/** YYYY-MM-DD. */
	date: string;
	/** One sentence for the notice and the top of the release's notes. */
	headline: string;
	announce: boolean;
	new?: readonly string[];
	improved?: readonly string[];
	fixed?: readonly string[];
	/** What the release adds for readers who also use Home Cards. The window introduces it, so it never assumes it. */
	withCompanion?: readonly string[];
}

export const RELEASE_GROUPS = [
	{ key: "new", label: "New" },
	{ key: "improved", label: "Improved" },
	{ key: "fixed", label: "Fixed" },
] as const satisfies readonly { key: keyof ReleaseNote; label: string }[];

/** The author's other plugin, introduced in the welcome window and the release notes. */
export const COMPANION = {
	name: "Home Cards",
	url: "https://community.obsidian.md/plugins/home-cards",
	about: "which turns your notes into a start page of cards",
} as const;

export const RELEASE_NOTES: readonly ReleaseNote[] = [
	{
		version: "1.0.0",
		date: "2026-10-22",
		headline: "The first release of Relate in Obsidian's community directory.",
		announce: false,
		new: [
			"When one note lists another in a relationship property, such as a project listing its notes, Relate adds the link back on the other note. The links stay in ordinary properties.",
			"The connections panel shows the open note's relationships and lets you add or remove links. The relationship browser follows chains of links across columns.",
			"Search understands relationships and dates, such as \"notes of Q3 Plan last month\", and shows how each result connects to the note you named. It also finds notes without a relationship, such as \"without project in Research\".",
			"Press Shift and Enter in search to link the results to a note in one step, with one undo.",
			"Check links finds links recorded on one note only and fixes them. A relationship can also say which notes need a link, such as every note in a folder, and Check links lists the ones that have none.",
			"Search by meaning, which is off until you turn it on, finds notes about an idea even when they use different words. It runs on your device.",
		],
		withCompanion: [
			"A Home Cards section can list the results of a Relate search, and each card says why it is there.",
			"A note's page in Home Cards gives each of the note's relationships a section of its own.",
		],
	},
];

type Parsed = [number, number, number];

function parse(v: string): Parsed | null {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is older than `b`. A version that does not parse counts as older than any that does. */
export function compareVersions(a: string, b: string): number {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function laterVersion(a: string, b: string): string {
	return compareVersions(a, b) >= 0 ? a : b;
}

/** Releases after `seen`, up to and including `current`, that announce themselves, newest first. */
export function unseenNotes(current: string, seen: string): ReleaseNote[] {
	return RELEASE_NOTES.filter(
		(n) => n.announce && compareVersions(n.version, seen) > 0 && compareVersions(n.version, current) <= 0
	);
}

/** The notes the window shows when nothing is unseen: the latest few. */
export function recentNotes(current: string, count = 3): ReleaseNote[] {
	return RELEASE_NOTES.filter((n) => compareVersions(n.version, current) <= 0).slice(0, count);
}
