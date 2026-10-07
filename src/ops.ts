import type { Grid } from "./csv";

export type Decimal = "." | ",";
export interface SortSpec {
	col: number;
	dir: "asc" | "desc";
}
export interface Rect {
	r0: number;
	r1: number;
	c0: number;
	c1: number;
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function colLabel(i: number): string {
	let s = "";
	let n = i + 1;
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

const blankRow = (cols: number): string[] => new Array(cols).fill("");

/**
 * Set cells, growing the grid when an edit lies outside it.
 * Copy-on-write: unchanged rows keep their identity, so snapshots stay cheap.
 */
export function applyEdits(g: Grid, edits: Array<[number, number, string]>): Grid {
	let rows = g.length;
	let cols = g[0] ? g[0].length : 1;
	for (const [r, c] of edits) {
		if (r + 1 > rows) rows = r + 1;
		if (c + 1 > cols) cols = c + 1;
	}
	let out = g.slice();
	if (cols > (g[0] ? g[0].length : 1)) {
		out = out.map((r) => (r.length < cols ? r.concat(blankRow(cols - r.length)) : r));
	}
	while (out.length < rows) out.push(blankRow(cols));
	const cloned = new Set<number>();
	for (const [r, c, v] of edits) {
		if (!cloned.has(r)) {
			out[r] = out[r].slice();
			cloned.add(r);
		}
		out[r][c] = v;
	}
	return out;
}

export function clearCells(g: Grid, rows: number[], c0: number, c1: number): Grid {
	const out = g.slice();
	for (const r of rows) {
		const src = g[r];
		let dirty = false;
		for (let c = c0; c <= c1; c++) {
			if (src[c] !== "") {
				dirty = true;
				break;
			}
		}
		if (!dirty) continue;
		const row = src.slice();
		for (let c = c0; c <= c1; c++) row[c] = "";
		out[r] = row;
	}
	return out;
}

export function insertRows(g: Grid, at: number, count: number): Grid {
	const cols = g[0] ? g[0].length : 1;
	const blanks: Grid = [];
	for (let i = 0; i < count; i++) blanks.push(blankRow(cols));
	return g.slice(0, at).concat(blanks, g.slice(at));
}

export function deleteRows(g: Grid, rows: Set<number>): Grid {
	const out = g.filter((_, i) => !rows.has(i));
	return out.length ? out : [blankRow(g[0] ? g[0].length : 1)];
}

export function insertCols(g: Grid, at: number, count: number): Grid {
	const fill = blankRow(count);
	return g.map((r) => r.slice(0, at).concat(fill, r.slice(at)));
}

export function deleteCols(g: Grid, c0: number, c1: number): Grid {
	const out = g.map((r) => r.slice(0, c0).concat(r.slice(c1 + 1)));
	return out[0] && out[0].length ? out : out.map(() => [""]);
}

// ---------------------------------------------------------------- numbers

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Parse a cell as a number honouring the decimal separator; null when not numeric. */
export function parseNumber(raw: string, dec: Decimal): number | null {
	if (raw === "") return null;
	let s = raw.trim().replace(/[\s ']/g, "");
	if (s === "") return null;
	if (dec === ".") {
		if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
	} else {
		if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "");
		s = s.replace(",", ".");
	}
	if (!NUM_RE.test(s)) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** Guess whether the data uses "," or "." as decimal separator. */
export function detectDecimal(g: Grid): Decimal {
	let comma = 0;
	let dot = 0;
	const limit = Math.min(g.length, 500);
	for (let r = 0; r < limit; r++) {
		for (const v of g[r]) {
			if (/^[-+]?\d+,\d+$/.test(v)) comma++;
			else if (/^[-+]?\d+\.\d+$/.test(v)) dot++;
		}
	}
	return comma > dot ? "," : ".";
}

export function formatNumber(n: number, dec: Decimal): string {
	const s = String(Number(n.toPrecision(12)));
	return dec === "," ? s.replace(".", ",") : s;
}

/** Swap the decimal separator of a plain number ("1,5" -> "1.5"); other text is untouched. */
export function convertDecimal(v: string, from: Decimal, to: Decimal): string {
	const re = from === "," ? /^([-+]?\d+),(\d+)([eE][-+]?\d+)?$/ : /^([-+]?\d+)\.(\d+)([eE][-+]?\d+)?$/;
	const m = v.trim().match(re);
	if (!m) return v;
	return m[1] + to + m[2] + (m[3] || "");
}

// ---------------------------------------------------------------- sorting

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Display order: order[displayRow] = dataRow. Sorting never mutates the grid.
 * When the first row is frozen (a header) it stays on top and is not sorted.
 */
export function computeOrder(g: Grid, spec: SortSpec | null, frozenFirst: boolean, dec: Decimal): number[] {
	const idx: number[] = [];
	for (let i = 0; i < g.length; i++) idx.push(i);
	if (!spec || !g[0] || spec.col >= g[0].length) return idx;
	const start = frozenFirst ? 1 : 0;
	const body = idx.slice(start);
	const key = new Map<number, { n: number | null; s: string }>();
	for (const i of body) {
		const s = g[i][spec.col];
		key.set(i, { n: parseNumber(s, dec), s });
	}
	const sign = spec.dir === "asc" ? 1 : -1;
	body.sort((a, b) => {
		const ka = key.get(a)!;
		const kb = key.get(b)!;
		const ea = ka.s === "";
		const eb = kb.s === "";
		if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // empties always last
		if (ka.n !== null && kb.n !== null) return (ka.n - kb.n) * sign;
		if (ka.n !== null) return -sign; // numbers before text when ascending
		if (kb.n !== null) return sign;
		return collator.compare(ka.s, kb.s) * sign;
	});
	return frozenFirst ? idx.slice(0, 1).concat(body) : body;
}

// ---------------------------------------------------------------- moving

/**
 * Move `count` items starting at `from` so they land before original index `ins`
 * (an insertion point 0..length). Returns the new array and where the block starts.
 */
export function moveRange<T>(arr: T[], from: number, count: number, ins: number): { arr: T[]; at: number } {
	const block = arr.slice(from, from + count);
	const rest = arr.slice(0, from).concat(arr.slice(from + count));
	const at = ins > from ? ins - count : ins;
	return { arr: rest.slice(0, at).concat(block, rest.slice(at)), at };
}

export function moveCols(g: Grid, from: number, count: number, ins: number): { grid: Grid; at: number } {
	let at = from;
	const grid = g.map((r) => {
		const m = moveRange(r, from, count, ins);
		at = m.at;
		return m.arr;
	});
	return { grid, at };
}

/** Where the item that used to be at index `i` ends up after moveRange(from, count, ins). */
export function mapMovedIndex(i: number, from: number, count: number, ins: number): number {
	const at = ins > from ? ins - count : ins;
	if (i >= from && i < from + count) return at + (i - from);
	const restIdx = i < from ? i : i - count;
	return restIdx >= at ? restIdx + count : restIdx;
}

/** Human readable reference of a selection: B3, B3:D9, B:D (whole columns), 3:5 (whole rows). */
export function refText(R: Rect, totalRows: number, totalCols: number): string {
	const a = colLabel(R.c0);
	const b = colLabel(R.c1);
	if (R.r0 === R.r1 && R.c0 === R.c1) return `${a}${R.r0 + 1}`;
	const fullCols = R.r0 === 0 && R.r1 === totalRows - 1;
	const fullRows = R.c0 === 0 && R.c1 === totalCols - 1;
	if (fullCols && fullRows) return `A1:${colLabel(totalCols - 1)}${totalRows}`;
	if (fullCols) return `${a}:${b}`;
	if (fullRows) return `${R.r0 + 1}:${R.r1 + 1}`;
	return `${a}${R.r0 + 1}:${b}${R.r1 + 1}`;
}
