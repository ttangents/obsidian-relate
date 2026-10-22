import { getIcon } from "obsidian";

/** The first icon this Obsidian build has. Newer Lucide icons are missing from older builds. */
function first(...names: string[]): string {
	return names.find((n) => getIcon(n) !== null) ?? names[names.length - 1];
}

/** Relate's own icons, in one place so the ribbon, panels and buttons agree. */
export const icons = {
	/** Relate itself: the ribbon and the Connections panel. */
	main: () => "workflow",
	/** The relationship browser. `graph-hub` is recent in Lucide, so older builds show `waypoints`. */
	browser: () => first("graph-hub", "waypoints"),
	checkLinks: () => first("list-check", "list-checks"),
};
