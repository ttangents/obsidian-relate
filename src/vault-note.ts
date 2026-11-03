/**
 * Which files Relate treats as the vault's notes.
 *
 * Since Obsidian 1.14.4 a Markdown file opened from outside the vault is a `TExternalFile`, a subclass of `TFile`,
 * and the metadata cache reports its changes too. Relate must never link to such a file, mirror a relationship from
 * it into a vault note, or index it. The vault returns the same object for each of its own paths and never an
 * outside file, so asking it tells the two apart; that also works on Obsidian 1.13, which has no `TExternalFile`.
 */

import type { App, TAbstractFile, TFile } from "obsidian";

/** True when `file` is a Markdown note that this vault holds. */
export function isVaultNote(app: App, file: TAbstractFile | null | undefined): file is TFile {
	if (!file || (file as Partial<TFile>).extension !== "md") return false;
	return app.vault.getAbstractFileByPath(file.path) === file;
}
