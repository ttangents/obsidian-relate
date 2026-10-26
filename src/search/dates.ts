/** A date phrase found in a query: the range of time it means, its label, and where it sits in the query. */
export interface DateMatch {
	from: number;
	to: number;
	label: string;
	start: number;
	end: number;
}

const DAY = 86_400_000;
const PREFIX = String.raw`(?:(?:from|in|during|over|since)\s+(?:the\s+)?)?`;

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
	const s = startOfDay(d);
	const offset = (s.getDay() + 6) % 7; // Monday starts the week
	return new Date(s.getTime() - offset * DAY);
}
function parseIso(s: string, end: boolean): number | null {
	const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
	if (!m) return null;
	const y = +m[1];
	const mo = +m[2] - 1;
	if (mo < 0 || mo > 11) return null;
	if (m[3]) {
		const d = new Date(y, mo, +m[3]);
		return end ? d.getTime() + DAY : d.getTime();
	}
	return end ? new Date(y, mo + 1, 1).getTime() : new Date(y, mo, 1).getTime();
}

type Rule = { re: RegExp; make: (m: RegExpMatchArray, now: Date) => { from: number; to: number; label: string } | null };

const RULES: Rule[] = [
	{
		re: new RegExp(String.raw`\b${PREFIX}(?:last|past)\s+(\d{1,3})\s+(day|week|month)s?\b`, "i"),
		make: (m, now) => {
			const n = +m[1];
			const unit = m[2].toLowerCase();
			const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
			return { from: now.getTime() - days * DAY, to: now.getTime() + 1, label: `last ${n} ${unit}${n === 1 ? "" : "s"}` };
		},
	},
	{
		re: new RegExp(String.raw`\b${PREFIX}today\b`, "i"),
		make: (_m, now) => ({ from: startOfDay(now).getTime(), to: now.getTime() + 1, label: "today" }),
	},
	{
		re: new RegExp(String.raw`\b${PREFIX}yesterday\b`, "i"),
		make: (_m, now) => {
			const t = startOfDay(now).getTime();
			return { from: t - DAY, to: t, label: "yesterday" };
		},
	},
	{
		re: new RegExp(String.raw`\b${PREFIX}(this|last|past)\s+(week|month|year)\b`, "i"),
		make: (m, now) => {
			const which = m[1].toLowerCase();
			const unit = m[2].toLowerCase();
			const label = `${which} ${unit}`;
			if (which === "past") {
				const days = unit === "week" ? 7 : unit === "month" ? 30 : 365;
				return { from: now.getTime() - days * DAY, to: now.getTime() + 1, label };
			}
			let thisStart: Date;
			let prevStart: Date;
			if (unit === "week") {
				thisStart = startOfWeek(now);
				prevStart = new Date(thisStart.getTime() - 7 * DAY);
			} else if (unit === "month") {
				thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
				prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			} else {
				thisStart = new Date(now.getFullYear(), 0, 1);
				prevStart = new Date(now.getFullYear() - 1, 0, 1);
			}
			return which === "this"
				? { from: thisStart.getTime(), to: now.getTime() + 1, label }
				: { from: prevStart.getTime(), to: thisStart.getTime(), label };
		},
	},
	{
		re: /\bsince\s+(\d{4}-\d{2}(?:-\d{2})?)\b/i,
		make: (m, now) => {
			const from = parseIso(m[1], false);
			return from === null ? null : { from, to: now.getTime() + 1, label: `since ${m[1]}` };
		},
	},
	{
		re: /\bbefore\s+(\d{4}-\d{2}(?:-\d{2})?)\b/i,
		make: (m) => {
			const to = parseIso(m[1], false);
			return to === null ? null : { from: 0, to, label: `before ${m[1]}` };
		},
	},
	{
		re: /\b(?:in|during|from|on)\s+((?:19|20)\d{2}-\d{2}(?:-\d{2})?)\b/i,
		make: (m) => {
			const from = parseIso(m[1], false);
			const to = parseIso(m[1], true);
			return from === null || to === null ? null : { from, to, label: m[1] };
		},
	},
	{
		re: /\b(?:in|during|from)\s+((?:19|20)\d{2})\b(?!-)/i,
		make: (m) => {
			const y = +m[1];
			return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: m[1] };
		},
	},
];

/** Finds the first date phrase in `text`. Character positions refer to `text`. */
export function findDate(text: string, now: Date = new Date()): DateMatch | null {
	let best: DateMatch | null = null;
	for (const rule of RULES) {
		const m = text.match(rule.re);
		if (!m || m.index === undefined) continue;
		const range = rule.make(m, now);
		if (!range) continue;
		const candidate = { ...range, start: m.index, end: m.index + m[0].length };
		if (!best || candidate.start < best.start) best = candidate;
	}
	return best;
}
