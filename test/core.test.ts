import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDelimiter, normalize, parseCsv, serializeCsv } from "../src/csv";
import {
	applyEdits,
	clearCells,
	colLabel,
	computeOrder,
	convertDecimal,
	deleteCols,
	deleteRows,
	detectDecimal,
	insertCols,
	insertRows,
	mapMovedIndex,
	moveCols,
	moveRange,
	parseNumber,
	refText,
} from "../src/ops";
import { columnStats } from "../src/stats";

test("parse handles quotes, embedded newlines and delimiters", () => {
	const text = 'a,b,c\n1,"x, y","line1\nline2"\n"he said ""hi""",,3\n';
	const rows = parseCsv(text, ",");
	assert.deepEqual(rows, [
		["a", "b", "c"],
		["1", "x, y", "line1\nline2"],
		['he said "hi"', "", "3"],
	]);
	assert.equal(serializeCsv(rows, ",") + "\n", text);
});

test("CRLF input and empty input", () => {
	assert.deepEqual(parseCsv("a;b\r\n1;2\r\n", ";"), [["a", "b"], ["1", "2"]]);
	assert.deepEqual(normalize(parseCsv("", ",")), [[""]]);
});

test("normalize pads ragged rows", () => {
	assert.deepEqual(normalize([["a"], ["1", "2", "3"]]), [["a", "", ""], ["1", "2", "3"]]);
});

test("delimiter detection", () => {
	assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
	assert.equal(detectDelimiter("a\tb\n1\t2\n3\t4"), "\t");
	assert.equal(detectDelimiter("a,b\n1,2\n"), ",");
	assert.equal(detectDelimiter("just one column\nsecond line"), null);
	assert.equal(detectDelimiter('name;note\nx;"a, b, c"\ny;"d, e"'), ";");
});

test("colLabel", () => {
	assert.equal(colLabel(0), "A");
	assert.equal(colLabel(25), "Z");
	assert.equal(colLabel(26), "AA");
	assert.equal(colLabel(701), "ZZ");
	assert.equal(colLabel(702), "AAA");
});

test("applyEdits is copy-on-write and grows the grid", () => {
	const g = [["a", "b"], ["c", "d"]];
	const out = applyEdits(g, [[0, 0, "X"]]);
	assert.equal(out[1], g[1]); // untouched row keeps identity
	assert.deepEqual(g, [["a", "b"], ["c", "d"]]); // original untouched
	assert.deepEqual(out[0], ["X", "b"]);
	const grown = applyEdits(g, [[3, 2, "z"]]);
	assert.equal(grown.length, 4);
	assert.ok(grown.every((r) => r.length === 3));
	assert.equal(grown[3][2], "z");
});

test("clear / insert / delete rows and columns", () => {
	const g = [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]];
	assert.deepEqual(clearCells(g, [0, 2], 1, 2), [["a", "", ""], ["d", "e", "f"], ["g", "", ""]]);
	assert.deepEqual(insertRows(g, 1, 2).map((r) => r[0]), ["a", "", "", "d", "g"]);
	assert.deepEqual(insertCols(g, 1, 1)[0], ["a", "", "b", "c"]);
	assert.deepEqual(deleteRows(g, new Set([0, 2])), [["d", "e", "f"]]);
	assert.deepEqual(deleteRows(g, new Set([0, 1, 2])), [["", "", ""]]);
	assert.deepEqual(deleteCols(g, 0, 1)[0], ["c"]);
	assert.deepEqual(deleteCols(g, 0, 2), [[""], [""], [""]]);
});

test("parseNumber with both decimal conventions", () => {
	assert.equal(parseNumber("1.5", "."), 1.5);
	assert.equal(parseNumber("1,5", ","), 1.5);
	assert.equal(parseNumber("1 234,5", ","), 1234.5);
	assert.equal(parseNumber("1.234,5", ","), 1234.5);
	assert.equal(parseNumber("1,234.5", "."), 1234.5);
	assert.equal(parseNumber("-2e3", "."), -2000);
	assert.equal(parseNumber("abc", "."), null);
	assert.equal(parseNumber("", "."), null);
	assert.equal(parseNumber("12abc", "."), null);
});

test("decimal detection and conversion", () => {
	assert.equal(detectDecimal([["1,5", "2,25"], ["3,1", "x"]]), ",");
	assert.equal(detectDecimal([["1.5", "2.25"]]), ".");
	assert.equal(detectDecimal([["abc"]]), ".");
	assert.equal(convertDecimal("1,5", ",", "."), "1.5");
	assert.equal(convertDecimal("-12,75e3", ",", "."), "-12.75e3");
	assert.equal(convertDecimal("hello, world", ",", "."), "hello, world");
	assert.equal(convertDecimal("3.14", ".", ","), "3,14");
});

test("sort: numeric, text, empties last, header frozen, stable", () => {
	const g = [["h"], ["10"], ["2"], [""], ["apple"], ["1"], ["Banana"]];
	assert.deepEqual(computeOrder(g, { col: 0, dir: "asc" }, true, "."), [0, 5, 2, 1, 4, 6, 3]);
	assert.deepEqual(computeOrder(g, { col: 0, dir: "desc" }, true, "."), [0, 6, 4, 1, 2, 5, 3]);
	assert.deepEqual(computeOrder(g, null, true, "."), [0, 1, 2, 3, 4, 5, 6]);
	assert.deepEqual(computeOrder(g, { col: 0, dir: "asc" }, false, ".").slice(-1), [3]);
	const dec = [["1,5"], ["1,25"], ["10,1"]];
	assert.deepEqual(computeOrder(dec, { col: 0, dir: "asc" }, false, ","), [1, 0, 2]);
});

test("column statistics", () => {
	const g = [["name", "v"], ["a", "1"], ["b", "3"], ["a", ""], ["c", "x"], ["a", "8"]];
	const [name, v] = columnStats(g, [0, 1], [1, 2, 3, 4, 5], ["name", "v"], ".");
	assert.equal(name.count, 5);
	assert.equal(name.unique, 3);
	assert.equal(name.top, "a");
	assert.equal(name.topCount, 3);
	assert.equal(name.sum, null);
	assert.equal(v.count, 4);
	assert.equal(v.empty, 1);
	assert.equal(v.numeric, 3);
	assert.equal(v.sum, 12);
	assert.equal(v.mean, 4);
	assert.equal(v.median, 3);
	assert.equal(v.min, 1);
	assert.equal(v.max, 8);
	assert.ok(Math.abs((v.stdev as number) - Math.sqrt(13)) < 1e-9);
});

test("moveRange / moveCols / mapMovedIndex", () => {
	const a = ["a", "b", "c", "d", "e"];
	assert.deepEqual(moveRange(a, 1, 2, 5), { arr: ["a", "d", "e", "b", "c"], at: 3 });
	assert.deepEqual(moveRange(a, 1, 2, 0), { arr: ["b", "c", "a", "d", "e"], at: 0 });
	assert.deepEqual(moveRange(a, 3, 1, 1), { arr: ["a", "d", "b", "c", "e"], at: 1 });
	assert.deepEqual(moveRange(a, 0, 1, 2).arr, ["b", "a", "c", "d", "e"]);
	assert.deepEqual(a, ["a", "b", "c", "d", "e"], "input untouched");
	// every old index maps to where the value really went
	for (const [from, count, ins] of [[1, 2, 5], [1, 2, 0], [3, 1, 1], [0, 1, 2], [4, 1, 0], [0, 2, 5]] as const) {
		const { arr } = moveRange(a, from, count, ins);
		a.forEach((v, i) => assert.equal(arr[mapMovedIndex(i, from, count, ins)], v, `${from},${count},${ins} idx ${i}`));
	}
	const g = [["a", "b", "c"], ["1", "2", "3"]];
	assert.deepEqual(moveCols(g, 0, 1, 3), { grid: [["b", "c", "a"], ["2", "3", "1"]], at: 2 });
	assert.deepEqual(moveRange(g, 0, 1, 2).arr, [g[1], g[0]]);
});

test("refText", () => {
	const R = (r0: number, r1: number, c0: number, c1: number) => ({ r0, r1, c0, c1 });
	assert.equal(refText(R(11, 11, 1, 1), 100, 5), "B12");
	assert.equal(refText(R(2, 8, 1, 3), 100, 5), "B3:D9");
	assert.equal(refText(R(0, 99, 1, 3), 100, 5), "B:D");
	assert.equal(refText(R(2, 4, 0, 4), 100, 5), "3:5");
	assert.equal(refText(R(0, 99, 0, 4), 100, 5), "A1:E100");
});
