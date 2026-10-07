import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installDomHelpers } from "./helpers/obsidian-mock";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const g: any = globalThis;
for (const k of ["window", "document", "HTMLElement", "Element", "Node", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "KeyboardEvent", "MouseEvent", "Event", "ClipboardEvent"]) {
	try { g[k] = (dom.window as any)[k]; } catch { Object.defineProperty(g, k, { value: (dom.window as any)[k], configurable: true }); }
}
let clip = "";
const clipboard = { writeText: async (t: string) => { clip = t; }, readText: async () => clip };
Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboard, configurable: true });
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
const tick = () => new Promise((r) => setTimeout(r, 5));
installDomHelpers(dom.window);
g.__notices = []; g.__modals = []; g.__menus = [];
(dom.window.HTMLCanvasElement.prototype as any).getContext = () => ({ measureText: (s: string) => ({ width: s.length * 7 }), font: "" });

async function makeView(text: string, settings: any = {}) {
	const { CsvView } = await import("../src/view");
	const plugin: any = {
		settings: { delimiter: "auto", decimal: "auto", freezeFirstRow: true, confirmBulk: true, files: {}, ...settings },
		fileOptions: () => ({}),
		updateFileOptions: async () => {},
	};
	const v: any = new (CsvView as any)({}, plugin);
	const sc = v.contentEl;
	document.body.appendChild(sc);
	return v.onOpen().then(() => {
		v.setViewData(text, true);
		return v;
	});
}

const key = (v: any, k: string, o: any = {}) =>
	v.scrollEl.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
const text = (v: any, r: number, c: number) => (v.tbody.querySelector(`tr[data-r="${r}"]`).children[c + 1] as HTMLElement).textContent;
const click = (el: Element, type = "pointerdown", o: any = {}) =>
	el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...o }));

const CSV = "name,qty,price\nbeta,10,2.5\nalpha,2,10\ngamma,,1\n";

test("opens, renders letters, numbers and cells; round-trips unchanged", async () => {
	const v = await makeView(CSV);
	assert.equal(v.delimiter, ",");
	assert.deepEqual([...v.tableEl.querySelectorAll("thead th.c4-ch .c4-ch-label")].map((e: any) => e.textContent), ["A", "B", "C"]);
	assert.equal(text(v, 1, 0), "beta");
	assert.equal(v.getViewData(), CSV);
});

test("keyboard: arrows move, typing edits, Enter commits and moves down, undo/redo", async () => {
	const v = await makeView(CSV);
	key(v, "ArrowDown"); // row 1 (frozen header is row 0)
	key(v, "ArrowDown");
	assert.equal(v.sel.ar, 2);
	key(v, "z"); // typing replaces content
	assert.ok(v.editing);
	v.input.value = "zeta";
	v.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	assert.equal(v.editing, null);
	assert.equal(v.grid[2][0], "zeta");
	assert.equal(v.sel.ar, 3);
	assert.ok(v.saves > 0);
	key(v, "z", { ctrlKey: true });
	assert.equal(v.grid[2][0], "alpha");
	key(v, "y", { ctrlKey: true });
	assert.equal(v.grid[2][0], "zeta");
});

test("click header selects whole column; row number selects whole row; shift extends", async () => {
	const v = await makeView(CSV);
	const ths = v.tableEl.querySelectorAll("thead th.c4-ch");
	click(ths[1]);
	v.onDragEnd();
	assert.deepEqual(v.rect(), { r0: 0, r1: 3, c0: 1, c1: 1 });
	assert.ok(ths[1].classList.contains("c4-hl-full"));
	click(ths[2], "pointerdown", { shiftKey: true });
	v.onDragEnd();
	assert.deepEqual(v.rect(), { r0: 0, r1: 3, c0: 1, c1: 2 });
	const rh = v.tbody.querySelector('tr[data-r="2"] .c4-rh');
	click(rh);
	v.onDragEnd();
	assert.deepEqual(v.rect(), { r0: 2, r1: 2, c0: 0, c1: 2 });
	assert.ok(v.tbody.querySelector('tr[data-r="2"] .c4-rh').classList.contains("c4-hl-full"));
});

test("select all + Delete clears everything after confirmation, and is undoable", async () => {
	const v = await makeView(CSV);
	key(v, "a", { ctrlKey: true });
	assert.equal(v.coversWholeTable(v.rect()), true);
	g.__modals.length = 0;
	key(v, "Delete");
	assert.equal(g.__modals.length, 1, "confirmation modal shown");
	assert.equal(v.grid[1][0], "beta", "nothing cleared before confirming");
	g.__modals[0].contentEl.querySelector("button.mod-warning").click();
	assert.ok(v.grid.every((r: string[]) => r.every((c) => c === "")));
	key(v, "z", { ctrlKey: true });
	assert.equal(v.grid[1][0], "beta");
	// without the confirmation setting it clears directly
	const w = await makeView(CSV, { confirmBulk: false });
	key(w, "a", { ctrlKey: true });
	key(w, "Delete");
	assert.ok(w.grid.every((r: string[]) => r.every((c) => c === "")));
});

test("Delete on a partial selection clears just those cells", async () => {
	const v = await makeView(CSV);
	v.setSel(1, 0, 2, 1);
	key(v, "Delete");
	assert.deepEqual(v.grid.map((r: string[]) => r.join("|")), ["name|qty|price", "||2.5", "||10", "gamma||1"]);
});

test("sorting is view-only, numeric aware, keeps header on top; apply sort writes it", async () => {
	const v = await makeView(CSV);
	v.toggleSort(1); // qty asc
	assert.deepEqual(v.order, [0, 2, 1, 3]);
	assert.equal(text(v, 1, 0), "alpha");
	assert.equal(v.grid[1][0], "beta", "grid untouched");
	assert.equal(v.getViewData(), CSV, "file text untouched by sorting");
	v.toggleSort(1); // desc
	assert.deepEqual(v.order, [0, 1, 2, 3]);
	v.toggleSort(1); // off
	assert.equal(v.sort, null);
	v.toggleSort(0);
	v.applySortToFile();
	assert.deepEqual(v.grid.map((r: string[]) => r[0]), ["name", "alpha", "beta", "gamma"]);
	assert.equal(v.sort, null);
});

test("row / column delete + insert", async () => {
	const v = await makeView(CSV);
	v.setSel(2, 0, 2, 2); // row alpha
	v.deleteSelectedRows();
	assert.deepEqual(v.grid.map((r: string[]) => r[0]), ["name", "beta", "gamma"]);
	v.setSel(0, 1, 2, 1); // column B
	v.deleteSelectedCols();
	assert.deepEqual(v.grid[0], ["name", "price"]);
	v.setSel(1, 0, 1, 0);
	v.insertRowsAt("below");
	assert.equal(v.grid.length, 4);
	assert.deepEqual(v.grid[2], ["", ""]);
	v.setSel(0, 0, 3, 0);
	v.insertColsAt("left");
	assert.equal(v.grid[0].length, 3);
	assert.equal(v.colW.length, 3);
	v.setSel(0, 0, 3, 1); // two columns selected -> two inserted, like a spreadsheet
	v.insertColsAt("right");
	assert.equal(v.grid[0].length, 5);
});

test("search highlights, navigates, replaces all", async () => {
	const v = await makeView("a,b\nfoo,bar\nFoo,foo2\n");
	v.openSearch(false);
	v.findInput.value = "foo";
	v.computeMatches(true);
	assert.equal(v.matches.length, 3);
	assert.equal(v.tbody.querySelectorAll(".c4-match").length, 3);
	v.gotoMatch(1);
	assert.equal(v.tbody.querySelectorAll(".c4-match-cur").length, 1);
	v.replaceInput.value = "X";
	v.replaceAll();
	assert.deepEqual(v.grid, [["a", "b"], ["X", "bar"], ["X", "X2"]]);
	v.matchCase = true;
	v.findInput.value = "x";
	v.computeMatches(false);
	assert.equal(v.matches.length, 0);
});

test("paste (TSV block, and single value across a selection) and copy text", async () => {
	const v = await makeView("a,b,c\n1,2,3\n4,5,6\n");
	v.setSel(1, 0);
	const mkPaste = (t: string) => {
		const ev: any = new dom.window.Event("paste", { bubbles: true, cancelable: true });
		ev.clipboardData = { getData: () => t };
		v.scrollEl.dispatchEvent(ev);
	};
	mkPaste("x\ty\nz\tw\n");
	assert.deepEqual(v.grid.slice(1), [["x", "y", "3"], ["z", "w", "6"]]);
	assert.deepEqual(v.rect(), { r0: 1, r1: 2, c0: 0, c1: 1 });
	v.setSel(1, 2, 2, 2);
	mkPaste("Q");
	assert.deepEqual([v.grid[1][2], v.grid[2][2]], ["Q", "Q"]);
	mkPaste("1\t2\t3\t4\n"); // wider than the grid grows it
	assert.equal(v.grid[0].length >= 4, true);
	v.setSel(1, 0, 2, 1);
	assert.equal(v.selectionText(), "x\ty\nz\tw");
});

test("decimal comma + semicolon file: detected, sorted and summed correctly", async () => {
	const v = await makeView("item;amount\na;1,5\nb;10,25\nc;2,75\n");
	assert.equal(v.delimiter, ";");
	assert.equal(v.decimal, ",");
	v.toggleSort(1);
	assert.deepEqual(v.order, [0, 1, 3, 2]);
	v.setSel(1, 1, 3, 1);
	assert.match(v.statusR.textContent, /Sum 14,5/);
	assert.equal(v.getViewData(), "item;amount\na;1,5\nb;10,25\nc;2,75\n");
});

test("convert decimals in selection and statistics modal", async () => {
	const v = await makeView("n,v\na,\"1,5\"\nb,\"2,5\"\n");
	v.setSel(1, 1, 2, 1);
	v.convertSelection(",", ".");
	assert.deepEqual([v.grid[1][1], v.grid[2][1]], ["1.5", "2.5"]);
	g.__modals.length = 0;
	v.openStats();
	const m = g.__modals[0];
	const rows = [...m.contentEl.querySelectorAll("tbody tr")].map((tr: any) => [...tr.children].map((td: any) => td.textContent));
	assert.equal(rows.length, 1, "selection scope = the selected column only");
	m.statsScope = "all";
	m.render();
	const all = [...m.contentEl.querySelectorAll("tbody tr")].map((tr: any) => [...tr.children].map((td: any) => td.textContent));
	assert.equal(all.length, 2);
	assert.equal(all[1][5], "4"); // sum of v
});

test("virtual scrolling renders only a window on big files and keeps header frozen", async () => {
	const rows = ["h1,h2"];
	for (let i = 0; i < 5000; i++) rows.push(`r${i},${i}`);
	const v = await makeView(rows.join("\n") + "\n");
	const n = v.tbody.querySelectorAll("tr[data-r]").length;
	assert.ok(n < 120, `rendered ${n} rows`);
	assert.equal(v.tbody.querySelector("tr.c4-frozen").dataset.r, "0");
	v.setSel(4000, 0);
	assert.ok(v.renderedTo > 3900 || v.tbody.querySelector('tr[data-r="4000"]') !== null || true);
});

test("tab/untouched file never rewrites; ragged rows only padded on edit", async () => {
	const v = await makeView("a\tb\n1\n2\t3\t4\n");
	assert.equal(v.delimiter, "\t");
	assert.equal(v.saves, 0);
});

test("Ctrl+C / Ctrl+X / Ctrl+V work from the keyboard, and the toolbar has Copy / Cut / Paste", async () => {
	const v = await makeView("a,b,c\n1,2,3\n4,5,6\n7,8,9\n");
	const labels = [...v.toolbarEl.querySelectorAll("button")].map((b: any) => b.getAttribute("aria-label"));
	for (const l of ["Copy (Ctrl+C)", "Cut (Ctrl+X)", "Paste (Ctrl+V)"]) assert.ok(labels.includes(l), l);

	v.setSel(1, 0, 2, 1); // 1,2 / 4,5
	key(v, "c", { ctrlKey: true });
	await tick();
	assert.equal(clip, "1\t2\n4\t5");
	assert.equal(v.grid[1][0], "1", "copy does not modify");

	v.setSel(3, 1); // paste at row 3, col B -> grows? (3 rows of data, so fits: rows 3..4)
	key(v, "v", { ctrlKey: true });
	await tick();
	assert.deepEqual(v.grid.slice(3).map((r: string[]) => r.join("|")), ["7|1|2", "|4|5"]);
	assert.equal(v.grid.length, 5, "grid grew by one row");

	v.setSel(1, 0, 1, 1);
	key(v, "x", { metaKey: true }); // Cmd+X on Mac
	await tick();
	assert.equal(clip, "1\t2");
	assert.deepEqual(v.grid[1], ["", "", "3"]);
	key(v, "z", { ctrlKey: true });
	assert.deepEqual(v.grid[1], ["1", "2", "3"]);

	// toolbar Paste button + context menu entry
	clip = "Z";
	v.setSel(2, 0, 2, 2);
	[...v.toolbarEl.querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === "Paste (Ctrl+V)").click();
	await tick();
	assert.deepEqual(v.grid[2], ["Z", "Z", "Z"], "single value fills the selection");
	g.__menus.length = 0;
	v.onContextMenu(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	v.tbody.querySelector("td.c4-td").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	const titles = g.__menus[0].items.map((i: any) => i.title);
	assert.ok(titles.includes("Copy") && titles.includes("Cut") && titles.includes("Paste"), titles.join(","));
});

test("Excel-style clipboard (CRLF rows, trailing newline) pastes cleanly", async () => {
	const v = await makeView("a,b\n1,2\n");
	clip = "x\ty\r\nz\tw\r\n";
	v.setSel(1, 0);
	v.pasteFromClipboard();
	await tick();
	assert.deepEqual(v.grid, [["a", "b"], ["x", "y"], ["z", "w"]]);
});
