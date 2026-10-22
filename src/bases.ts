import type { Side } from "./settings";

function quote(s: string): string {
	return JSON.stringify(s);
}

/**
 * A Bases code block listing the notes this note has under `side.prop`. The block reads the other side,
 * `side.inverse`, on each candidate note, so it keeps working if Relate is uninstalled, as long as both sides
 * were recorded. `this.file` is the note the block is embedded in.
 */
export function baseBlock(side: Side): string {
	const filter = `list(note[${quote(side.inverse)}]).filter(value.linksTo(this.file)).length > 0`;
	return [
		"```base",
		"filters:",
		"  and:",
		`    - ${quoteYaml(filter)}`,
		"views:",
		"  - type: table",
		`    name: ${quoteYaml(side.prop)}`,
		"    order:",
		"      - file.name",
		"      - file.folder",
		"```",
		"",
	].join("\n");
}

/** Single-quoted YAML scalar, which keeps double quotes inside the formula intact. */
function quoteYaml(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}
