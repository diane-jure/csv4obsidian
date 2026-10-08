export type Grid = string[][];

export const DELIMITERS = [",", ";", "\t", "|"];

/** RFC 4180 style parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string, delim: string): Grid {
	const rows: Grid = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === delim) {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += ch;
		i++;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function quoteField(f: string, delim: string): string {
	if (f.indexOf('"') >= 0 || f.indexOf(delim) >= 0 || f.indexOf("\n") >= 0 || f.indexOf("\r") >= 0) {
		return '"' + f.replace(/"/g, '""') + '"';
	}
	return f;
}

export function serializeCsv(rows: Grid, delim: string, newline = "\n"): string {
	return rows.map((r) => r.map((f) => quoteField(f, delim)).join(delim)).join(newline);
}

/** Make the grid rectangular and at least 1x1. */
export function normalize(rows: Grid): Grid {
	let width = 1;
	for (const r of rows) if (r.length > width) width = r.length;
	if (rows.length === 0) return [new Array(width).fill("")];
	return rows.map((r) => (r.length < width ? r.concat(new Array(width - r.length).fill("")) : r));
}

export function detectNewline(text: string): string {
	return text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
}

/** Returns the most plausible delimiter, or null when the sample has no tabular structure. */
export function detectDelimiter(text: string): string | null {
	const LIMIT = 20000;
	const sample = text.slice(0, LIMIT);
	let best: string | null = null;
	let bestScore = 0;
	let bestCols = 0;
	for (const d of DELIMITERS) {
		let rows = parseCsv(sample, d);
		if (text.length > LIMIT && rows.length > 1) rows.pop(); // possibly truncated line
		rows = rows.slice(0, 40).filter((r) => !(r.length === 1 && r[0] === ""));
		if (!rows.length) continue;
		const freq = new Map<number, number>();
		for (const r of rows) freq.set(r.length, (freq.get(r.length) || 0) + 1);
		let mode = 0;
		let modeN = 0;
		freq.forEach((cnt, len) => {
			if (cnt > modeN || (cnt === modeN && len > mode)) {
				mode = len;
				modeN = cnt;
			}
		});
		if (mode < 2) continue;
		const score = modeN / rows.length;
		if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && mode > bestCols)) {
			best = d;
			bestScore = score;
			bestCols = mode;
		}
	}
	return best;
}
