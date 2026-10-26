import type { SemanticSettings } from "../settings";

/** Per-device key-value storage, such as Obsidian's local storage for this vault. */
export interface DeviceStorage {
	load(key: string): unknown;
	save(key: string, value: unknown): void;
}

const MODEL_KEY = "relate-model-consent";
/** The server address this device agreed to send note text to. */
const SERVER_KEY = "relate-server-consent";

/**
 * What this device agreed to. Kept per device, outside the synced settings, so a setting that arrives by sync
 * never starts a download or sends a note anywhere.
 */
export class Consent {
	constructor(private storage: DeviceStorage, private modelId: string) {}

	/** This device agreed to download the built-in model. */
	get model(): boolean {
		return this.storage.load(MODEL_KEY) === this.modelId;
	}

	/** Records that this device agreed to download the built-in model. */
	allowModel(): void {
		this.storage.save(MODEL_KEY, this.modelId);
	}

	/** Forgets the agreement to download, so Relate asks again. */
	forgetModel(): void {
		this.storage.save(MODEL_KEY, null);
	}

	/** This device agreed to send note text to exactly `url`. */
	server(url: string): boolean {
		const clean = url.trim();
		return !!clean && this.storage.load(SERVER_KEY) === clean;
	}

	/** Records that this device agreed to send note text to `url`. Only the consent window and its button call this. */
	allowServer(url: string): void {
		this.storage.save(SERVER_KEY, url.trim() || null);
	}
}

/** What turning on search by meaning needs first on this device. */
export type MeaningPlan =
	| { kind: "start" }
	| { kind: "ask-model" }
	| { kind: "ask-server"; url: string }
	| { kind: "needs-address" };

/**
 * Decides whether turning on search by meaning can start now or must first ask this device's user. With
 * `askEachDownload`, as when the device cannot keep the model, the built-in model needs a yes every time.
 */
export function meaningPlan(s: SemanticSettings, consent: Consent, askEachDownload = false): MeaningPlan {
	if (s.source === "server") {
		const url = s.serverUrl.trim();
		if (!url || !s.serverModel.trim()) return { kind: "needs-address" };
		return consent.server(url) ? { kind: "start" } : { kind: "ask-server", url };
	}
	return consent.model && !askEachDownload ? { kind: "start" } : { kind: "ask-model" };
}
