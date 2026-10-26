// A small in-memory stand-in for the parts of Obsidian's API that Relate's core uses.
type Fm = Record<string, unknown>;

export class TFile {
	extension = "md";
	stat = { ctime: 0, mtime: 0, size: 0 };
	parent = { path: "/" };
	constructor(public path: string) {}
	get basename(): string {
		return this.path.replace(/^.*\//, "").replace(/\.md$/, "");
	}
}

/** Tags as Obsidian reports them: frontmatter tags and inline tags, each with "#". */
export function getAllTags(cache: { frontmatter?: Record<string, unknown> }): string[] {
	const raw = cache.frontmatter?.tags;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	return list.filter((t): t is string => typeof t === "string").map((t) => `#${t.replace(/^#/, "")}`);
}

export function getLinkpath(link: string): string {
	return link.split(/[#^|]/)[0];
}

export class Notice {
	static messages: string[] = [];
	constructor(msg: unknown) {
		Notice.messages.push(typeof msg === "string" ? msg : "[fragment]");
	}
	hide(): void {}
}

/** The browser globals Relate's code reaches for, as Obsidian would provide them. */
const browser = globalThis as unknown as Record<string, unknown>;
browser.window = globalThis;
browser.createFragment = (fn: (f: { appendText(): void; createEl(): { addEventListener(): void } }) => void) => {
	const f = { appendText() {}, createEl: () => ({ addEventListener() {} }) };
	fn(f);
	return f;
};

/** A deep copy, as Obsidian hands a fresh object to each reader. */
function copy(fm: Fm): Fm {
	return JSON.parse(JSON.stringify(fm)) as Fm;
}

function linksOf(fm: Fm): { key: string; link: string; original: string }[] {
	const out: { key: string; link: string; original: string }[] = [];
	for (const [k, v] of Object.entries(fm)) {
		const push = (val: unknown, key: string) => {
			if (typeof val !== "string") return;
			const m = val.match(/^\[\[([^\]]+)\]\]$/);
			if (m) out.push({ key, link: m[1].split("|")[0], original: val });
		};
		if (Array.isArray(v)) v.forEach((x, i) => push(x, `${k}.${i}`));
		else push(v, k);
	}
	return out;
}

export class FakeApp {
	files = new Map<string, TFile>();
	/** What is in each file now. */
	fm = new Map<string, Fm>();
	/** What Obsidian's metadata cache says. Like the real cache, it catches up only when a change event fires. */
	cache = new Map<string, Fm>();
	/** Paths whose next property write throws, to simulate a failed save. */
	failWrites = new Set<string>();
	/** Paths whose next read throws. */
	failReads = new Set<string>();
	reads = 0;
	/** Milliseconds before the metadata cache catches up with a write, as when Obsidian is busy re-reading notes. */
	cacheLag = 1;
	/** A different lag for some notes. */
	lag = new Map<string, number>();
	listeners: ((f: TFile) => void)[] = [];
	/** Notes whose YAML is currently unparseable, as while a user is mid-edit. */
	unparsed = new Set<string>();

	/** Simulates Obsidian failing to parse a note's YAML, then reporting the change. */
	breakYaml(path: string): void {
		this.unparsed.add(path);
		this.pending++;
		setTimeout(() => {
			for (const l of this.listeners) l(this.files.get(path)!);
			this.pending--;
		}, 1);
	}
	pending = 0;

	add(path: string, fm: Fm = {}): TFile {
		const f = new TFile(path);
		this.files.set(path, f);
		this.fm.set(path, copy(fm));
		this.cache.set(path, copy(fm));
		return f;
	}

	/** Simulates the user editing a note's properties directly. */
	async edit(path: string, fn: (fm: Fm) => void): Promise<void> {
		await this.fileManager.processFrontMatter(this.files.get(path)!, fn);
	}

	/** Waits until all change events, and the writes they cause, have run. */
	async settle(): Promise<void> {
		for (let i = 0; i < 200; i++) {
			await new Promise((r) => setTimeout(r, 2));
			if (this.pending === 0) {
				await new Promise((r) => setTimeout(r, 120));
				if (this.pending === 0) return;
			}
		}
		throw new Error("did not settle");
	}

	onChanged(fn: (f: TFile) => void): void {
		this.listeners.push(fn);
	}

	vault = {
		getMarkdownFiles: () => [...this.files.values()],
		getAbstractFileByPath: (p: string) => this.files.get(p) ?? null,
		cachedRead: async (f: TFile) => {
			this.reads++;
			if (this.failReads.delete(f.path)) throw new Error("read failed");
			return `---\n---\n${f.basename} body`;
		},
	};

	metadataCache = {
		getFileCache: (f: TFile) => {
			if (this.unparsed.has(f.path)) return { frontmatterPosition: {}, frontmatter: undefined, frontmatterLinks: [] };
			const fm = this.cache.get(f.path);
			return fm ? { frontmatter: fm, frontmatterLinks: linksOf(fm), frontmatterPosition: Object.keys(fm).length ? {} : undefined } : null;
		},
		on: (_name: string, fn: (f: TFile) => void) => {
			this.listeners.push(fn);
			return fn;
		},
		offref: (ref: unknown) => {
			this.listeners = this.listeners.filter((l) => l !== ref);
		},
		getFirstLinkpathDest: (lp: string, _src: string) => {
			for (const f of this.files.values()) if (f.basename === lp || f.path === lp || f.path === lp + ".md") return f;
			return null;
		},
		fileToLinktext: (f: TFile) => f.basename,
	};

	fileManager = {
		processFrontMatter: async (f: TFile, fn: (fm: Fm) => void) => {
			if (this.failWrites.delete(f.path)) throw new Error(`could not save ${f.path}`);
			const fm = copy(this.fm.get(f.path) ?? {});
			this.unparsed.delete(f.path);
			fn(fm);
			const before = JSON.stringify(this.fm.get(f.path));
			this.fm.set(f.path, fm);
			if (JSON.stringify(fm) === before) return;
			this.pending++;
			setTimeout(() => {
				this.cache.set(f.path, copy(this.fm.get(f.path) ?? {}));
				for (const l of this.listeners) l(f);
				this.pending--;
			}, this.lag.get(f.path) ?? this.cacheLag);
		},
	};
}
