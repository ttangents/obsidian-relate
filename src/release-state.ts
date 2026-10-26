import { laterVersion, unseenNotes, type ReleaseNote } from "./release-notes";
import type { DeviceStorage } from "./semantic/consent";

/** This device's copy of the newest release seen; see release-notes.ts. */
const RELEASE_KEY = "relate-release-seen";

/** What the release state reads and writes. */
export interface ReleaseHost {
	/** The installed version, from the manifest. */
	version: string;
	storage: DeviceStorage;
	settings: { showReleaseNotes: boolean; lastShownVersion: string };
	/** Saves the settings after the synced marker moves. */
	save(): void;
}

/** Which release notes the Connections panel announces, and the markers that record what the reader has seen. */
export class ReleaseState {
	/** Releases the Connections panel announces, newest first; empty once read or dismissed. */
	notes: ReleaseNote[] = [];

	constructor(private host: ReleaseHost) {}

	/** The newest release seen: the later of the synced and this device's marker. */
	private seen(): string {
		const local = this.host.storage.load(RELEASE_KEY);
		return laterVersion(this.host.settings.lastShownVersion, typeof local === "string" ? local : "");
	}

	private markSeen(): void {
		const current = this.host.version;
		const local = this.host.storage.load(RELEASE_KEY);
		this.host.storage.save(RELEASE_KEY, laterVersion(typeof local === "string" ? local : "", current));
		const synced = laterVersion(this.host.settings.lastShownVersion, current);
		if (synced === this.host.settings.lastShownVersion) return;
		this.host.settings.lastShownVersion = synced;
		this.host.save();
	}

	/** At load: a new install is welcomed instead; an update queues its notes, unless announcements are off. */
	review(firstRun: boolean): void {
		const notes = firstRun || !this.host.settings.showReleaseNotes ? [] : unseenNotes(this.host.version, this.seen());
		if (notes.length) this.notes = notes;
		else this.markSeen();
	}

	/** Marks the queued notes read. Returns false when nothing was queued. */
	dismiss(): boolean {
		if (!this.notes.length) return false;
		this.notes = [];
		this.markSeen();
		return true;
	}
}
