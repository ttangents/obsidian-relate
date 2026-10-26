/** One recorded error, kept in the settings file so it can be read when a panel fails. */
export interface ErrorEntry {
	time: number;
	where: string;
	message: string;
}

/** Where the log keeps its entries. */
export interface ErrorHost {
	settings: { errors: ErrorEntry[] };
	/** Saves the settings after an entry is added. */
	save(): void;
}

/** How many recent errors the settings file keeps. */
const KEEP = 5;
/** The same error from the same place is recorded at most once in this many milliseconds. */
const REPEAT_MS = 60_000;

/**
 * Records errors in the console and the settings file. The same error from the same place, such as a server that
 * is down while the user types a search, is recorded once a minute at most, so it never floods the settings file.
 */
export class ErrorLog {
	private last = new Map<string, number>();

	constructor(private host: ErrorHost, private now: () => number = () => Date.now()) {}

	/** Records `e`, unless it repeats an error recorded within the last minute, and returns a plain message. */
	report(where: string, e: unknown): string {
		const short = e instanceof Error ? e.message : String(e);
		const key = `${where}\u0000${short}`;
		const time = this.now();
		const previous = this.last.get(key);
		if (previous !== undefined && time - previous < REPEAT_MS) return short;
		this.last.set(key, time);
		console.error(`Relate (${where}):`, e);
		const message = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
		this.host.settings.errors = [...this.host.settings.errors, { time, where, message }].slice(-KEEP);
		this.host.save();
		return short;
	}
}
