import type { Grid } from "./csv";
import { Decimal, parseNumber } from "./ops";

export interface ColStats {
	col: number;
	name: string;
	count: number; // non-empty
	empty: number;
	unique: number;
	numeric: number;
	sum: number | null;
	mean: number | null;
	median: number | null;
	min: number | null;
	max: number | null;
	stdev: number | null;
	top: string | null;
	topCount: number;
}

export function columnStats(
	g: Grid,
	cols: number[],
	rows: number[],
	names: string[],
	dec: Decimal
): ColStats[] {
	return cols.map((col, k) => {
		const seen = new Map<string, number>();
		const nums: number[] = [];
		let count = 0;
		for (const r of rows) {
			const v = g[r][col];
			if (v === "") continue;
			count++;
			seen.set(v, (seen.get(v) || 0) + 1);
			const n = parseNumber(v, dec);
			if (n !== null) nums.push(n);
		}
		let top: string | null = null;
		let topCount = 0;
		seen.forEach((n, v) => {
			if (n > topCount) {
				top = v;
				topCount = n;
			}
		});
		const st: ColStats = {
			col,
			name: names[k],
			count,
			empty: rows.length - count,
			unique: seen.size,
			numeric: nums.length,
			sum: null,
			mean: null,
			median: null,
			min: null,
			max: null,
			stdev: null,
			top,
			topCount,
		};
		if (nums.length) {
			const sorted = nums.slice().sort((a, b) => a - b);
			const sum = nums.reduce((a, b) => a + b, 0);
			const mean = sum / nums.length;
			const mid = Math.floor(sorted.length / 2);
			st.sum = sum;
			st.mean = mean;
			st.median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
			st.min = sorted[0];
			st.max = sorted[sorted.length - 1];
			if (nums.length > 1) {
				const variance = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (nums.length - 1);
				st.stdev = Math.sqrt(variance);
			}
		}
		return st;
	});
}
