/**
 * Relate shows one Connections panel. Obsidian can end up holding two: it restores a plugin's panels in place
 * after an update or a restart, sometimes after Relate has already put a panel back, and the saved layout then
 * keeps both. Relate keeps one and closes the rest.
 */

/**
 * The panels to close, given every Connections panel in the workspace. Relate keeps the first one the reader can
 * see, or the first one when none is in view, so the panel the reader is looking at never disappears.
 */
export function extraPanels<T>(panels: readonly T[], isVisible: (panel: T) => boolean): T[] {
	if (panels.length < 2) return [];
	const keep = panels.find(isVisible) ?? panels[0];
	return panels.filter((p) => p !== keep);
}
