import { Menu, Notice, TextFileView, WorkspaceLeaf, setIcon } from "obsidian";
import type Csv4ObsidianPlugin from "./main";
import { Grid, detectDelimiter, detectNewline, normalize, parseCsv, serializeCsv } from "./csv";
import {
	Decimal,
	Rect,
	SortSpec,
	applyEdits,
	clearCells,
	colLabel,
	computeOrder,
	convertDecimal,
	deleteCols,
	deleteRows,
	detectDecimal,
	formatNumber,
	insertCols,
	insertRows,
	parseNumber,
} from "./ops";
import { columnStats } from "./stats";
import { ConfirmModal, StatsModal, StatsScope } from "./modals";
import { DECIMAL_LABELS, DELIMITER_LABELS } from "./settings";

export const VIEW_TYPE = "csv4obsidian-view";

const ROW_H = 28;
const OVERSCAN = 20;
const MAX_HISTORY = 200;
const MIN_COL_W = 64;
const MAX_COL_W = 480;
const ARROW_UP = "▲";
const ARROW_DOWN = "▼";

interface Sel {
	ar: number; // anchor (active cell)
	ac: number;
	fr: number; // focus (moving end)
	fc: number;
}

interface Snapshot {
	grid: Grid;
	sort: SortSpec | null;
	colW: number[];
}

type Hit =
	| { kind: "corner" }
	| { kind: "col"; c: number }
	| { kind: "row"; r: number }
	| { kind: "cell"; r: number; c: number };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class CsvView extends TextFileView {
	private grid: Grid = [[""]];
	private delimiter = ",";
	private newline = "\n";
	private trailingNewline = true;
	private bom = false;
	private freeze = true;
	private decimal: Decimal = ".";
	private sort: SortSpec | null = null;
	private order: number[] = [0];
	private colW: number[] = [];
	private sel: Sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
	private past: Snapshot[] = [];
	private future: Snapshot[] = [];

	private editing: { r: number; c: number } | null = null;
	private editCancelled = false;
	private dragMode: "cell" | "row" | "col" | null = null;
	private lastPointer = "mouse";

	// DOM
	private toolbarEl!: HTMLElement;
	private undoBtn!: HTMLButtonElement;
	private redoBtn!: HTMLButtonElement;
	private searchEl!: HTMLElement;
	private findInput!: HTMLInputElement;
	private replaceInput!: HTMLInputElement;
	private countEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private tableEl!: HTMLElement;
	private tbody!: HTMLElement;
	private input!: HTMLInputElement;
	private statusL!: HTMLElement;
	private statusR!: HTMLElement;
	private rnW = 48;
	private renderedFrom = 0;
	private renderedTo = 0;
	private rafId = 0;
	private measureCtx: CanvasRenderingContext2D | null = null;

	// search
	private searchOpen = false;
	private matchCase = false;
	private matches: Array<[number, number]> = [];
	private matchSet = new Set<string>();
	private matchIdx = -1;

	constructor(leaf: WorkspaceLeaf, private plugin: Csv4ObsidianPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return this.file ? this.file.basename : "CSV";
	}
	getIcon() {
		return "table";
	}
	canAcceptExtension(ext: string) {
		return ext === "csv" || ext === "tsv";
	}

	// ------------------------------------------------------------------ file <-> grid

	getViewData(): string {
		if (this.grid.length === 1 && this.grid[0].every((v) => v === "")) return this.bom ? "﻿" : "";
		const body = serializeCsv(this.grid, this.delimiter, this.newline);
		return (this.bom ? "﻿" : "") + body + (this.trailingNewline ? this.newline : "");
	}

	setViewData(data: string, clear: boolean): void {
		let text = data;
		this.bom = text.charCodeAt(0) === 0xfeff;
		if (this.bom) text = text.slice(1);
		this.newline = detectNewline(text);
		this.trailingNewline = text.length === 0 || /\n$/.test(text);
		const opt = this.plugin.fileOptions(this.file?.path);
		this.delimiter = this.resolveDelimiter(text, opt.delimiter);
		this.grid = normalize(parseCsv(text, this.delimiter));
		this.decimal = this.resolveDecimal(opt.decimal);
		this.freeze = opt.freeze ?? this.plugin.settings.freezeFirstRow;
		if (clear) {
			this.past = [];
			this.future = [];
			this.sort = null;
			this.colW = [];
			this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
			this.editing = null;
		}
		this.afterGridChange(false);
		if (clear) this.autoFitColumns();
		this.renderAll();
	}

	clear(): void {
		this.grid = [[""]];
		this.past = [];
		this.future = [];
	}

	private resolveDelimiter(text: string, override?: string): string {
		if (override) return override;
		const g = this.plugin.settings.delimiter;
		if (g !== "auto") return g;
		return detectDelimiter(text) ?? (this.file?.extension === "tsv" ? "\t" : ",");
	}

	private resolveDecimal(override?: Decimal): Decimal {
		if (override) return override;
		const g = this.plugin.settings.decimal;
		return g === "auto" ? detectDecimal(this.grid) : g;
	}

	// ------------------------------------------------------------------ geometry helpers

	private nRows() {
		return this.order.length;
	}
	private nCols() {
		return this.grid[0].length;
	}
	private rect(): Rect {
		const s = this.sel;
		return {
			r0: Math.min(s.ar, s.fr),
			r1: Math.max(s.ar, s.fr),
			c0: Math.min(s.ac, s.fc),
			c1: Math.max(s.ac, s.fc),
		};
	}
	private dataRow(dr: number): number {
		return dr < this.order.length ? this.order[dr] : dr;
	}
	private cell(dr: number, c: number): string {
		const row = this.grid[this.dataRow(dr)];
		return row ? row[c] ?? "" : "";
	}
	private clamp(v: number, lo: number, hi: number) {
		return Math.max(lo, Math.min(hi, v));
	}

	private clampSel() {
		const R = this.nRows() - 1;
		const C = this.nCols() - 1;
		const s = this.sel;
		this.sel = {
			ar: this.clamp(s.ar, 0, R),
			ac: this.clamp(s.ac, 0, C),
			fr: this.clamp(s.fr, 0, R),
			fc: this.clamp(s.fc, 0, C),
		};
	}

	private ensureColW() {
		const n = this.nCols();
		while (this.colW.length < n) this.colW.push(120);
		if (this.colW.length > n) this.colW.length = n;
	}

	/** Size each column to its content like Omni Viewer does (64–480 px). */
	private autoFitColumns(onlyCol?: number) {
		this.ensureColW();
		if (!this.measureCtx) {
			this.measureCtx = document.createElement("canvas").getContext("2d");
		}
		const ctx = this.measureCtx;
		if (!ctx) return;
		const cs = getComputedStyle(this.scrollEl || this.contentEl);
		const fs = cs.fontSize || "13px";
		ctx.font = `${fs} ${cs.fontFamily}`;
		const boldFont = `600 ${fs} ${cs.fontFamily}`;
		const limit = Math.min(this.grid.length, 300);
		const from = onlyCol ?? 0;
		const to = onlyCol ?? this.nCols() - 1;
		for (let c = from; c <= to; c++) {
			ctx.font = boldFont;
			let w = ctx.measureText(colLabel(c)).width + 34; // letter + sort arrow
			ctx.font = `${fs} ${cs.fontFamily}`;
			for (let r = 0; r < limit; r++) {
				const v = this.grid[r][c];
				if (v) {
					const tw = ctx.measureText(v.length > 80 ? v.slice(0, 80) : v).width + 18;
					if (tw > w) w = tw;
				}
			}
			this.colW[c] = this.clamp(Math.ceil(w), MIN_COL_W, MAX_COL_W);
		}
	}

	private afterGridChange(keepOrder: boolean) {
		this.ensureColW();
		if (this.sort && this.sort.col >= this.nCols()) this.sort = null;
		if (!keepOrder || this.order.length !== this.grid.length) {
			this.order = computeOrder(this.grid, this.sort, this.freeze, this.decimal);
		}
		this.clampSel();
		if (this.searchOpen) this.computeMatches(false);
	}

	// ------------------------------------------------------------------ history

	private snapshot(): Snapshot {
		return { grid: this.grid, sort: this.sort, colW: this.colW.slice() };
	}

	private commit(next: Grid, extra: { sort?: SortSpec | null; colW?: number[]; sel?: Sel } = {}) {
		this.past.push(this.snapshot());
		if (this.past.length > MAX_HISTORY) this.past.shift();
		this.future = [];
		const sameShape = next.length === this.grid.length && next[0].length === this.grid[0].length;
		this.grid = next;
		const sortChanged = "sort" in extra;
		if (sortChanged) this.sort = extra.sort ?? null;
		if (extra.colW) this.colW = extra.colW;
		if (extra.sel) this.sel = extra.sel;
		this.afterGridChange(sameShape && !sortChanged);
		this.renderAll();
		this.requestSave();
	}

	undo() {
		const s = this.past.pop();
		if (!s) return;
		this.future.push(this.snapshot());
		this.restore(s);
	}

	redo() {
		const s = this.future.pop();
		if (!s) return;
		this.past.push(this.snapshot());
		this.restore(s);
	}

	private restore(s: Snapshot) {
		this.commitEditIfAny();
		this.grid = s.grid;
		this.sort = s.sort;
		this.colW = s.colW;
		this.afterGridChange(false);
		this.renderAll();
		this.requestSave();
	}

	// ------------------------------------------------------------------ UI construction

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("c4-root");
		root.style.setProperty("--c4-row-h", ROW_H + "px");

		this.buildToolbar(root);
		this.buildSearch(root);

		this.scrollEl = root.createDiv({ cls: "c4-scroll", attr: { tabindex: "0" } });
		this.tableEl = this.scrollEl.createEl("table", { cls: "c4-table" });
		const status = root.createDiv({ cls: "c4-status" });
		this.statusL = status.createSpan();
		this.statusR = status.createSpan({ cls: "c4-status-r" });

		this.input = document.createElement("input");
		this.input.className = "c4-input";
		this.input.spellcheck = false;
		this.input.addEventListener("keydown", (e) => this.onInputKey(e));
		this.input.addEventListener("blur", () => this.onInputBlur());
		this.input.addEventListener("pointerdown", (e) => e.stopPropagation());

		const s = this.scrollEl;
		this.registerDomEvent(s, "pointerdown", (e) => this.onPointerDown(e));
		this.registerDomEvent(s, "click", (e) => this.onClick(e));
		this.registerDomEvent(s, "dblclick", (e) => this.onDblClick(e));
		this.registerDomEvent(s, "contextmenu", (e) => this.onContextMenu(e));
		this.registerDomEvent(s, "keydown", (e) => this.onKeyDown(e));
		this.registerDomEvent(s, "copy", (e) => this.onCopy(e, false));
		this.registerDomEvent(s, "cut", (e) => this.onCopy(e, true));
		this.registerDomEvent(s, "paste", (e) => this.onPaste(e));
		this.registerDomEvent(s, "scroll", () => this.onScroll());

		this.renderAll();
	}

	async onClose() {
		cancelAnimationFrame(this.rafId);
		document.removeEventListener("pointermove", this.onDragMove);
		document.removeEventListener("pointerup", this.onDragEnd);
	}

	private button(parent: HTMLElement, icon: string, label: string, fn: (e: MouseEvent) => void, text?: string) {
		const b = parent.createEl("button", { cls: "c4-btn", attr: { "aria-label": label, title: label } });
		setIcon(b, icon);
		if (text) b.createSpan({ text, cls: "c4-btn-text" });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			fn(e);
		});
		return b;
	}

	private buildToolbar(root: HTMLElement) {
		const tb = (this.toolbarEl = root.createDiv({ cls: "c4-toolbar" }));
		this.undoBtn = this.button(tb, "undo-2", "Undo (Ctrl+Z)", () => this.undo());
		this.redoBtn = this.button(tb, "redo-2", "Redo (Ctrl+Y)", () => this.redo());
		tb.createDiv({ cls: "c4-sep" });
		this.button(tb, "copy", "Copy (Ctrl+C)", () => this.copyToClipboard(false));
		this.button(tb, "scissors", "Cut (Ctrl+X)", () => this.copyToClipboard(true));
		this.button(tb, "clipboard-paste", "Paste (Ctrl+V)", () => this.pasteFromClipboard());
		tb.createDiv({ cls: "c4-sep" });
		this.button(tb, "search", "Find and replace (Ctrl+F)", () => this.openSearch(false));
		this.button(tb, "plus", "Insert", (e) => this.insertMenu().showAtMouseEvent(e));
		this.button(tb, "trash-2", "Delete", (e) => this.deleteMenu().showAtMouseEvent(e));
		this.button(tb, "arrow-up-down", "Sort", (e) => this.sortMenu(this.sel.ac).showAtMouseEvent(e));
		tb.createDiv({ cls: "c4-sep" });
		this.button(tb, "sigma", "Column statistics", () => this.openStats(), "Statistics");
		tb.createDiv({ cls: "c4-grow" });
		this.button(tb, "settings", "Table settings", (e) => this.settingsMenu().showAtMouseEvent(e));
	}

	private updateToolbar() {
		this.undoBtn.toggleClass("is-disabled", this.past.length === 0);
		this.redoBtn.toggleClass("is-disabled", this.future.length === 0);
	}

	// ------------------------------------------------------------------ rendering

	private renderAll() {
		if (!this.tableEl) return;
		this.commitEditIfAny();
		const table = this.tableEl;
		const keepTop = this.scrollEl.scrollTop;
		const keepLeft = this.scrollEl.scrollLeft;
		table.empty();
		const total = this.nRows();
		const m = this.nCols();
		this.rnW = Math.max(44, String(total).length * 9 + 26);
		const widthSum = this.colW.reduce((a, b) => a + b, 0);
		table.style.width = this.rnW + widthSum + "px";

		const cg = table.createEl("colgroup");
		cg.createEl("col").style.width = this.rnW + "px";
		for (let c = 0; c < m; c++) cg.createEl("col").style.width = this.colW[c] + "px";

		const tr = table.createEl("thead").createEl("tr");
		const corner = tr.createEl("th", { cls: "c4-corner", attr: { title: "Select all (Ctrl+A)" } });
		corner.dataset.kind = "corner";
		for (let c = 0; c < m; c++) {
			const th = tr.createEl("th", { cls: "c4-ch" });
			th.dataset.c = String(c);
			th.createSpan({ cls: "c4-ch-label", text: colLabel(c) });
			const sorted = this.sort && this.sort.col === c;
			th.toggleClass("c4-sorted", !!sorted);
			th.createSpan({
				cls: "c4-sort",
				text: sorted ? (this.sort!.dir === "asc" ? ARROW_UP : ARROW_DOWN) : "↕",
				attr: { title: "Sort this column" },
			});
			th.createDiv({ cls: "c4-resizer", attr: { title: "Drag to resize, double-click to fit" } });
		}
		this.tbody = table.createEl("tbody");
		this.renderBody(keepTop);
		this.scrollEl.scrollTop = keepTop;
		this.scrollEl.scrollLeft = keepLeft;
		this.updateStatus();
		this.updateToolbar();
	}

	private visibleBounds(topOverride?: number): { fv: number; lv: number } {
		const top = topOverride ?? this.scrollEl.scrollTop;
		const h = this.scrollEl.clientHeight || 800;
		return {
			fv: Math.floor(top / ROW_H) - 1,
			lv: Math.ceil((top + h) / ROW_H) - 1,
		};
	}

	private renderBody(topOverride?: number) {
		this.commitEditIfAny();
		const tbody = this.tbody;
		const total = this.nRows();
		const bodyStart = this.freeze && total > 0 ? 1 : 0;
		// Read the scroll position before touching the DOM: emptying the table makes
		// the browser clamp scrollTop to 0.
		const { fv, lv } = this.visibleBounds(topOverride);
		const from = Math.max(bodyStart, fv - OVERSCAN);
		const to = Math.min(total, lv + 1 + OVERSCAN);
		this.renderedFrom = from;
		this.renderedTo = to;
		const R = this.rect();
		const frag = document.createDocumentFragment();
		if (bodyStart === 1) frag.appendChild(this.buildRow(0, R));
		if (from > bodyStart) frag.appendChild(this.spacer((from - bodyStart) * ROW_H));
		for (let dr = from; dr < to; dr++) frag.appendChild(this.buildRow(dr, R));
		if (to < total) frag.appendChild(this.spacer((total - to) * ROW_H));
		tbody.replaceChildren(frag);
	}

	private spacer(h: number): HTMLElement {
		const tr = document.createElement("tr");
		tr.className = "c4-spacer";
		const td = document.createElement("td");
		td.colSpan = this.nCols() + 1;
		td.style.height = h + "px";
		tr.appendChild(td);
		return tr;
	}

	private buildRow(dr: number, R: Rect): HTMLElement {
		const frozen = this.freeze && dr === 0;
		const row = this.grid[this.order[dr]];
		const tr = document.createElement("tr");
		tr.dataset.r = String(dr);
		tr.className = frozen ? "c4-frozen" : dr % 2 ? "c4-odd" : "";
		const rh = document.createElement("th");
		rh.className = "c4-rh";
		rh.textContent = String(dr + 1);
		tr.appendChild(rh);
		for (let c = 0; c < row.length; c++) {
			const v = row[c];
			const td = document.createElement("td");
			td.className = "c4-td";
			td.dataset.c = String(c);
			td.textContent = v;
			if (v.length > 24) td.title = v.length > 400 ? v.slice(0, 400) + "…" : v;
			if (!frozen && v !== "" && parseNumber(v, this.decimal) !== null) td.classList.add("c4-num");
			this.applyState(td, dr, c, R);
			tr.appendChild(td);
		}
		this.applyHeaderState(rh, dr >= R.r0 && dr <= R.r1, R.c0 === 0 && R.c1 === this.nCols() - 1);
		return tr;
	}

	private applyHeaderState(el: HTMLElement, inSel: boolean, full: boolean) {
		el.classList.toggle("c4-hl", inSel);
		el.classList.toggle("c4-hl-full", inSel && full);
	}

	private applyState(td: HTMLElement, dr: number, c: number, R: Rect) {
		const inRect = dr >= R.r0 && dr <= R.r1 && c >= R.c0 && c <= R.c1;
		const multi = R.r0 !== R.r1 || R.c0 !== R.c1;
		const cl = td.classList;
		cl.toggle("c4-sel", inRect && multi);
		cl.toggle("c4-t", inRect && dr === R.r0);
		cl.toggle("c4-b", inRect && dr === R.r1);
		cl.toggle("c4-l", inRect && c === R.c0);
		cl.toggle("c4-r", inRect && c === R.c1);
		cl.toggle("c4-active", dr === this.sel.ar && c === this.sel.ac);
		if (this.searchOpen && this.matchSet.size) {
			const key = this.order[dr] + ":" + c;
			cl.toggle("c4-match", this.matchSet.has(key));
			const cur = this.matchIdx >= 0 ? this.matches[this.matchIdx] : null;
			cl.toggle("c4-match-cur", !!cur && cur[0] === dr && cur[1] === c);
		} else {
			cl.remove("c4-match", "c4-match-cur");
		}
	}

	/** Cheap in-place update of selection classes (keeps DOM nodes alive for dblclick). */
	private refreshSelection() {
		const R = this.rect();
		const m = this.nCols();
		const total = this.nRows();
		this.tbody.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr) => {
			const dr = Number(tr.dataset.r);
			const rh = tr.firstElementChild as HTMLElement;
			this.applyHeaderState(rh, dr >= R.r0 && dr <= R.r1, R.c0 === 0 && R.c1 === m - 1);
			for (let i = 1; i < tr.children.length; i++) {
				const td = tr.children[i] as HTMLElement;
				this.applyState(td, dr, i - 1, R);
			}
		});
		this.tableEl.querySelectorAll<HTMLElement>("thead th.c4-ch").forEach((th) => {
			const c = Number(th.dataset.c);
			this.applyHeaderState(th, c >= R.c0 && c <= R.c1, R.r0 === 0 && R.r1 === total - 1);
		});
		this.updateStatus();
	}

	private onScroll() {
		if (this.rafId) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = 0;
			const total = this.nRows();
			const bodyStart = this.freeze && total > 0 ? 1 : 0;
			const { fv, lv } = this.visibleBounds();
			if ((fv < this.renderedFrom && this.renderedFrom > bodyStart) || (lv + 1 > this.renderedTo && this.renderedTo < total)) {
				this.renderBody();
			}
		});
	}

	private updateStatus() {
		if (!this.statusL) return;
		const R = this.rect();
		const cells = (R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1);
		const dataRows = this.nRows() - (this.freeze ? 1 : 0);
		this.statusL.setText(
			`${Math.max(0, dataRows).toLocaleString()} rows × ${this.nCols().toLocaleString()} columns` +
				(this.sort ? `  ·  sorted by ${colLabel(this.sort.col)} ${this.sort.dir === "asc" ? ARROW_UP : ARROW_DOWN}` : "")
		);
		let right = "";
		if (cells > 1) {
			if (cells > 200000) {
				right = `${cells.toLocaleString()} cells selected`;
			} else {
				let count = 0;
				let n = 0;
				let sum = 0;
				for (let r = R.r0; r <= R.r1; r++) {
					for (let c = R.c0; c <= R.c1; c++) {
						const v = this.cell(r, c);
						if (v === "") continue;
						count++;
						const x = parseNumber(v, this.decimal);
						if (x !== null) {
							n++;
							sum += x;
						}
					}
				}
				right = `Count ${count.toLocaleString()}`;
				if (n > 0) right += `  ·  Sum ${formatNumber(sum, this.decimal)}  ·  Avg ${formatNumber(sum / n, this.decimal)}`;
			}
		}
		const delim = DELIMITER_LABELS.find(([v]) => v === this.delimiter)?.[1].split(" ")[0] ?? "?";
		this.statusR.setText((right ? right + "  ·  " : "") + `${delim}  ·  decimal "${this.decimal}"`);
	}

	// ------------------------------------------------------------------ selection

	private setSel(ar: number, ac: number, fr = ar, fc = ac, reveal = true) {
		this.sel = { ar, ac, fr, fc };
		this.clampSel();
		this.refreshSelection();
		if (reveal) this.reveal(this.sel.fr, this.sel.fc);
		if (this.searchOpen) this.syncMatchToSelection();
	}

	private reveal(dr: number, c: number) {
		const s = this.scrollEl;
		const total = this.nRows();
		const bodyStart = this.freeze && total > 0 ? 1 : 0;
		if (dr >= bodyStart) {
			const rowTop = ROW_H * (1 + dr);
			const topLimit = s.scrollTop + ROW_H * (1 + bodyStart);
			const viewBottom = s.scrollTop + s.clientHeight - 16;
			if (rowTop < topLimit) s.scrollTop = rowTop - ROW_H * (1 + bodyStart);
			else if (rowTop + ROW_H > viewBottom) s.scrollTop = rowTop + ROW_H - s.clientHeight + 16;
		}
		let left = this.rnW;
		for (let i = 0; i < c; i++) left += this.colW[i];
		const w = this.colW[c];
		if (left < s.scrollLeft + this.rnW) s.scrollLeft = left - this.rnW;
		else if (left + w > s.scrollLeft + s.clientWidth - 16) s.scrollLeft = left + w - s.clientWidth + 16;
		this.onScroll();
	}

	private selectAll() {
		this.setSel(0, 0, this.nRows() - 1, this.nCols() - 1, false);
	}

	private move(dr: number, dc: number, extend: boolean) {
		const s = this.sel;
		if (extend) this.setSel(s.ar, s.ac, s.fr + dr, s.fc + dc);
		else {
			const r = this.clamp(s.ar + dr, 0, this.nRows() - 1);
			const c = this.clamp(s.ac + dc, 0, this.nCols() - 1);
			this.setSel(r, c);
		}
	}

	private hit(el: Element | null): Hit | null {
		if (!el) return null;
		const t = (el as HTMLElement).closest?.("th, td") as HTMLElement | null;
		if (!t || !this.tableEl.contains(t)) return null;
		if (t.classList.contains("c4-corner")) return { kind: "corner" };
		if (t.classList.contains("c4-ch")) return { kind: "col", c: Number(t.dataset.c) };
		if (t.classList.contains("c4-rh")) return { kind: "row", r: Number((t.parentElement as HTMLElement).dataset.r) };
		if (t.classList.contains("c4-td")) {
			return { kind: "cell", r: Number((t.parentElement as HTMLElement).dataset.r), c: Number(t.dataset.c) };
		}
		return null;
	}

	private applyHit(h: Hit, shift: boolean) {
		const R = this.nRows() - 1;
		const C = this.nCols() - 1;
		const s = this.sel;
		switch (h.kind) {
			case "corner":
				this.selectAll();
				break;
			case "col":
				if (shift) this.setSel(0, s.ac, R, h.c, false);
				else this.setSel(0, h.c, R, h.c, false);
				break;
			case "row":
				if (shift) this.setSel(s.ar, 0, h.r, C, false);
				else this.setSel(h.r, 0, h.r, C, false);
				break;
			case "cell":
				if (shift) this.setSel(s.ar, s.ac, h.r, h.c, false);
				else this.setSel(h.r, h.c, h.r, h.c, false);
				break;
		}
	}

	// ------------------------------------------------------------------ pointer events

	private onPointerDown(e: PointerEvent) {
		this.lastPointer = e.pointerType;
		const t = e.target as HTMLElement;
		if (t.closest(".c4-resizer")) {
			this.startResize(e, t.closest(".c4-ch") as HTMLElement);
			return;
		}
		if (e.pointerType === "touch" || (e.button !== 0 && e.pointerType === "mouse")) return;
		if (t.closest(".c4-sort") || t.closest(".c4-input")) return;
		this.commitEditIfAny();
		const h = this.hit(t);
		if (!h) return;
		this.applyHit(h, e.shiftKey);
		this.dragMode = h.kind === "cell" ? "cell" : h.kind === "row" ? "row" : h.kind === "col" ? "col" : null;
		if (this.dragMode) {
			document.addEventListener("pointermove", this.onDragMove);
			document.addEventListener("pointerup", this.onDragEnd);
		}
	}

	private onDragMove = (e: PointerEvent) => {
		if (!this.dragMode) return;
		const h = this.hit(document.elementFromPoint(e.clientX, e.clientY));
		if (!h) return;
		const s = this.sel;
		const R = this.nRows() - 1;
		const C = this.nCols() - 1;
		if (this.dragMode === "cell" && h.kind === "cell") {
			if (h.r !== s.fr || h.c !== s.fc) this.setSel(s.ar, s.ac, h.r, h.c, false);
		} else if (this.dragMode === "col" && (h.kind === "col" || h.kind === "cell")) {
			if (h.c !== s.fc) this.setSel(0, s.ac, R, h.c, false);
		} else if (this.dragMode === "row" && (h.kind === "row" || h.kind === "cell")) {
			if (h.r !== s.fr) this.setSel(s.ar, 0, h.r, C, false);
		}
	};

	private onDragEnd = () => {
		this.dragMode = null;
		document.removeEventListener("pointermove", this.onDragMove);
		document.removeEventListener("pointerup", this.onDragEnd);
	};

	private onClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		const sortBtn = t.closest(".c4-sort");
		if (sortBtn) {
			const th = sortBtn.closest(".c4-ch") as HTMLElement;
			this.toggleSort(Number(th.dataset.c));
			return;
		}
		if (this.lastPointer === "touch") {
			const h = this.hit(t);
			if (!h) return;
			const same =
				h.kind === "cell" && this.sel.ar === h.r && this.sel.ac === h.c && this.sel.fr === h.r && this.sel.fc === h.c;
			if (same) this.startEdit();
			else this.applyHit(h, false);
		}
	}

	private onDblClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		if (t.closest(".c4-resizer")) {
			const th = t.closest(".c4-ch") as HTMLElement;
			this.autoFitColumns(Number(th.dataset.c));
			this.renderAll();
			return;
		}
		const h = this.hit(t);
		if (h && h.kind === "cell") {
			this.setSel(h.r, h.c, h.r, h.c, false);
			this.startEdit();
		}
	}

	private startResize(e: PointerEvent, th: HTMLElement) {
		e.preventDefault();
		e.stopPropagation();
		const c = Number(th.dataset.c);
		const startX = e.clientX;
		const startW = this.colW[c];
		const cols = this.tableEl.querySelectorAll("col");
		const move = (ev: PointerEvent) => {
			this.colW[c] = this.clamp(startW + ev.clientX - startX, 40, 1200);
			(cols[c + 1] as HTMLElement).style.width = this.colW[c] + "px";
			this.tableEl.style.width = this.rnW + this.colW.reduce((a, b) => a + b, 0) + "px";
		};
		const up = () => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", up);
		};
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", up);
	}

	private onContextMenu(e: MouseEvent) {
		const h = this.hit(e.target as HTMLElement);
		if (!h) return;
		e.preventDefault();
		const R = this.rect();
		const inside =
			(h.kind === "cell" && h.r >= R.r0 && h.r <= R.r1 && h.c >= R.c0 && h.c <= R.c1) ||
			(h.kind === "row" && h.r >= R.r0 && h.r <= R.r1) ||
			(h.kind === "col" && h.c >= R.c0 && h.c <= R.c1);
		if (!inside) this.applyHit(h, false);
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Copy").setIcon("copy").onClick(() => this.copyToClipboard(false)));
		menu.addItem((i) => i.setTitle("Cut").setIcon("scissors").onClick(() => this.copyToClipboard(true)));
		menu.addItem((i) => i.setTitle("Paste").setIcon("clipboard-paste").onClick(() => this.pasteFromClipboard()));
		menu.addItem((i) => i.setTitle("Clear contents").setIcon("eraser").onClick(() => this.clearSelection()));
		menu.addSeparator();
		this.fillInsertItems(menu);
		this.fillDeleteItems(menu);
		menu.addSeparator();
		this.fillSortItems(menu, this.sel.ac);
		menu.addSeparator();
		this.fillConvertItems(menu);
		menu.showAtMouseEvent(e);
	}

	// ------------------------------------------------------------------ keyboard

	private onKeyDown(e: KeyboardEvent) {
		if (this.editing) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key;
		if (mod && !e.altKey) {
			const k = key.toLowerCase();
			if (k === "z") {
				e.preventDefault();
				e.shiftKey ? this.redo() : this.undo();
				return;
			}
			if (k === "y") {
				e.preventDefault();
				this.redo();
				return;
			}
			if (k === "a") {
				e.preventDefault();
				this.selectAll();
				return;
			}
			if (k === "c" || k === "x") {
				e.preventDefault();
				this.copyToClipboard(k === "x");
				return;
			}
			if (k === "v") {
				e.preventDefault();
				this.pasteFromClipboard();
				return;
			}
			if (k === "f" || k === "h") {
				e.preventDefault();
				this.openSearch(k === "h");
				return;
			}
		}
		const R = this.nRows() - 1;
		const C = this.nCols() - 1;
		const page = Math.max(1, Math.floor((this.scrollEl.clientHeight || 400) / ROW_H) - 2);
		switch (key) {
			case "ArrowUp":
				e.preventDefault();
				if (mod) {
					if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, 0, this.sel.fc);
					else this.setSel(0, this.sel.ac);
				} else this.move(-1, 0, e.shiftKey);
				return;
			case "ArrowDown":
				e.preventDefault();
				if (mod) {
					if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, R, this.sel.fc);
					else this.setSel(R, this.sel.ac);
				} else this.move(1, 0, e.shiftKey);
				return;
			case "ArrowLeft":
				e.preventDefault();
				if (mod) {
					if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, this.sel.fr, 0);
					else this.setSel(this.sel.ar, 0);
				} else this.move(0, -1, e.shiftKey);
				return;
			case "ArrowRight":
				e.preventDefault();
				if (mod) {
					if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, this.sel.fr, C);
					else this.setSel(this.sel.ar, C);
				} else this.move(0, 1, e.shiftKey);
				return;
			case "PageUp":
				e.preventDefault();
				this.move(-page, 0, e.shiftKey);
				return;
			case "PageDown":
				e.preventDefault();
				this.move(page, 0, e.shiftKey);
				return;
			case "Home":
				e.preventDefault();
				if (mod) this.setSel(0, 0);
				else if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, this.sel.fr, 0);
				else this.setSel(this.sel.ar, 0);
				return;
			case "End":
				e.preventDefault();
				if (mod) this.setSel(R, C);
				else if (e.shiftKey) this.setSel(this.sel.ar, this.sel.ac, this.sel.fr, C);
				else this.setSel(this.sel.ar, C);
				return;
			case "Tab":
				e.preventDefault();
				this.tabMove(e.shiftKey ? -1 : 1);
				return;
			case "Enter":
			case "F2":
				e.preventDefault();
				this.startEdit();
				return;
			case "Delete":
			case "Backspace":
				e.preventDefault();
				this.clearSelection();
				return;
			case "Escape":
				if (this.searchOpen) this.closeSearch();
				else this.setSel(this.sel.ar, this.sel.ac);
				return;
		}
		if (key.length === 1 && !mod && !e.altKey) {
			e.preventDefault();
			this.startEdit(key);
		}
	}

	private tabMove(dir: 1 | -1) {
		const s = this.sel;
		let r = s.ar;
		let c = s.ac + dir;
		if (c >= this.nCols()) {
			c = 0;
			r++;
		} else if (c < 0) {
			c = this.nCols() - 1;
			r--;
		}
		this.setSel(this.clamp(r, 0, this.nRows() - 1), c);
	}

	// ------------------------------------------------------------------ cell editing

	private cellEl(dr: number, c: number): HTMLElement | null {
		const tr = this.tbody.querySelector<HTMLElement>(`tr[data-r="${dr}"]`);
		return tr ? (tr.children[c + 1] as HTMLElement) : null;
	}

	private startEdit(initial?: string) {
		if (this.editing) return;
		const { ar: r, ac: c } = this.sel;
		this.setSel(r, c, r, c);
		let td = this.cellEl(r, c);
		if (!td) {
			this.renderBody();
			td = this.cellEl(r, c);
		}
		if (!td) return;
		this.editing = { r, c };
		this.editCancelled = false;
		td.classList.add("c4-editing");
		td.textContent = "";
		td.appendChild(this.input);
		this.input.value = initial ?? this.cell(r, c);
		this.input.focus();
		const end = this.input.value.length;
		this.input.setSelectionRange(end, end);
	}

	private onInputKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Enter") {
			e.preventDefault();
			this.finishEdit(true, e.shiftKey ? [-1, 0] : [1, 0]);
		} else if (e.key === "Tab") {
			e.preventDefault();
			this.finishEdit(true, e.shiftKey ? [0, -1] : [0, 1]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			this.finishEdit(false);
		}
	}

	private onInputBlur() {
		if (this.editing) this.finishEdit(!this.editCancelled);
	}

	private commitEditIfAny() {
		if (this.editing) this.finishEdit(true);
	}

	private finishEdit(save: boolean, step?: [number, number]) {
		const ed = this.editing;
		if (!ed) return;
		this.editing = null;
		this.editCancelled = !save;
		const value = this.input.value;
		const td = this.input.parentElement;
		if (td) {
			td.classList.remove("c4-editing");
			this.input.remove();
			td.textContent = this.cell(ed.r, ed.c);
		}
		if (save && value !== this.cell(ed.r, ed.c)) {
			this.commit(applyEdits(this.grid, [[this.dataRow(ed.r), ed.c, value]]));
		}
		if (step) this.move(step[0], step[1], false);
		this.scrollEl.focus({ preventScroll: true });
	}

	// ------------------------------------------------------------------ edit operations

	private selectedDataRows(R: Rect): number[] {
		const rows: number[] = [];
		for (let r = R.r0; r <= R.r1; r++) rows.push(this.order[r]);
		return rows;
	}

	private coversWholeTable(R: Rect): boolean {
		return R.r0 === 0 && R.r1 === this.nRows() - 1 && R.c0 === 0 && R.c1 === this.nCols() - 1;
	}

	private confirmThen(whole: boolean, message: string, label: string, fn: () => void) {
		if (whole && this.plugin.settings.confirmBulk) new ConfirmModal(this.app, message, label, fn).open();
		else fn();
	}

	clearSelection() {
		const R = this.rect();
		const run = () => {
			const next = clearCells(this.grid, this.selectedDataRows(R), R.c0, R.c1);
			if (next.every((row, i) => row === this.grid[i])) return;
			this.commit(next);
		};
		this.confirmThen(this.coversWholeTable(R), "Clear the contents of the whole table? You can undo this.", "Clear all", run);
	}

	private deleteSelectedRows() {
		const R = this.rect();
		const whole = R.r0 === 0 && R.r1 === this.nRows() - 1;
		this.confirmThen(whole, "Delete every row? You can undo this.", "Delete all rows", () => {
			const next = deleteRows(this.grid, new Set(this.selectedDataRows(R)));
			this.commit(next, { sel: { ar: R.r0, ac: 0, fr: R.r0, fc: this.nCols() - 1 } });
		});
	}

	private deleteSelectedCols() {
		const R = this.rect();
		const whole = R.c0 === 0 && R.c1 === this.nCols() - 1;
		this.confirmThen(whole, "Delete every column? You can undo this.", "Delete all columns", () => {
			const count = R.c1 - R.c0 + 1;
			const colW = this.colW.slice(0, R.c0).concat(this.colW.slice(R.c1 + 1));
			let sort = this.sort;
			if (sort) {
				if (sort.col >= R.c0 && sort.col <= R.c1) sort = null;
				else if (sort.col > R.c1) sort = { ...sort, col: sort.col - count };
			}
			this.commit(deleteCols(this.grid, R.c0, R.c1), {
				sort,
				colW: colW.length ? colW : [120],
				sel: { ar: 0, ac: R.c0, fr: this.nRows() - 1, fc: R.c0 },
			});
		});
	}

	/** Rows that follow the current sort become the real order of the file. */
	private bakedGrid(): Grid {
		return this.sort ? this.order.map((i) => this.grid[i]) : this.grid;
	}

	private insertRowsAt(where: "above" | "below") {
		const R = this.rect();
		const count = R.r1 - R.r0 + 1;
		const at = where === "above" ? R.r0 : R.r1 + 1;
		const next = insertRows(this.bakedGrid(), at, count);
		this.commit(next, { sort: null, sel: { ar: at, ac: 0, fr: at + count - 1, fc: this.nCols() - 1 } });
	}

	private insertColsAt(where: "left" | "right") {
		const R = this.rect();
		const count = R.c1 - R.c0 + 1;
		const at = where === "left" ? R.c0 : R.c1 + 1;
		const colW = this.colW.slice(0, at).concat(new Array(count).fill(120), this.colW.slice(at));
		const sort = this.sort && this.sort.col >= at ? { ...this.sort, col: this.sort.col + count } : this.sort;
		this.commit(insertCols(this.grid, at, count), {
			sort,
			colW,
			sel: { ar: 0, ac: at, fr: this.nRows() - 1, fc: at + count - 1 },
		});
	}

	private applySortToFile() {
		if (!this.sort) {
			new Notice("No sort is active");
			return;
		}
		this.commit(this.bakedGrid(), { sort: null });
	}

	private toggleSort(c: number) {
		this.commitEditIfAny();
		this.setSortSpec(!this.sort || this.sort.col !== c ? { col: c, dir: "asc" } : this.sort.dir === "asc" ? { col: c, dir: "desc" } : null);
	}

	private setSortSpec(spec: SortSpec | null) {
		this.sort = spec;
		this.order = computeOrder(this.grid, this.sort, this.freeze, this.decimal);
		if (this.searchOpen) this.computeMatches(false);
		this.renderAll();
	}

	private convertSelection(from: Decimal, to: Decimal) {
		const R = this.rect();
		const edits: Array<[number, number, string]> = [];
		for (let r = R.r0; r <= R.r1; r++) {
			for (let c = R.c0; c <= R.c1; c++) {
				const v = this.cell(r, c);
				const nv = convertDecimal(v, from, to);
				if (nv !== v) edits.push([this.dataRow(r), c, nv]);
			}
		}
		if (!edits.length) {
			new Notice(`No numbers with "${from}" found in the selection`);
			return;
		}
		this.commit(applyEdits(this.grid, edits));
		new Notice(`Converted ${edits.length} value${edits.length > 1 ? "s" : ""}`);
	}

	// ------------------------------------------------------------------ clipboard

	private copyToClipboard(cut: boolean) {
		const text = this.selectionText();
		if (text === null) return;
		const R = this.rect();
		const cells = (R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1);
		this.writeClipboard(text)
			.then(() => {
				new Notice(`${cut ? "Cut" : "Copied"} ${cells.toLocaleString()} cell${cells > 1 ? "s" : ""}`);
				if (cut) this.clearSelection();
			})
			.catch(() => new Notice("Could not access the clipboard"));
	}

	private async writeClipboard(text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
	}

	private pasteFromClipboard() {
		if (this.editing) return;
		navigator.clipboard
			.readText()
			.then((text) => {
				if (text === "") new Notice("The clipboard is empty");
				else this.pasteText(text);
			})
			.catch(() => new Notice("Could not read the clipboard. Allow clipboard access, or use Ctrl+V."));
	}

	private selectionText(): string | null {
		const R = this.rect();
		if ((R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1) > 2_000_000) {
			new Notice("Selection is too large to copy");
			return null;
		}
		const block: Grid = [];
		for (let r = R.r0; r <= R.r1; r++) {
			const row: string[] = [];
			for (let c = R.c0; c <= R.c1; c++) row.push(this.cell(r, c));
			block.push(row);
		}
		return serializeCsv(block, "\t", "\n");
	}

	private onCopy(e: ClipboardEvent, cut: boolean) {
		if (this.editing) return;
		const text = this.selectionText();
		if (text === null || !e.clipboardData) return;
		e.clipboardData.setData("text/plain", text);
		e.preventDefault();
		if (cut) this.clearSelection();
	}

	private onPaste(e: ClipboardEvent) {
		if (this.editing || !e.clipboardData) return;
		const text = e.clipboardData.getData("text/plain");
		if (text === "") return;
		e.preventDefault();
		this.pasteText(text);
	}

	private pasteText(raw: string) {
		const text = raw.replace(/\r\n$|\n$/, "");
		const block = /[\t\n]/.test(text) ? parseCsv(text, "\t") : [[text]];
		const R = this.rect();
		const edits: Array<[number, number, string]> = [];
		let sel: Sel;
		if (block.length === 1 && block[0].length === 1) {
			for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) edits.push([this.dataRow(r), c, block[0][0]]);
			sel = this.sel;
		} else {
			let maxC = 0;
			block.forEach((row, i) => {
				maxC = Math.max(maxC, row.length);
				row.forEach((v, j) => edits.push([this.dataRow(R.r0 + i), R.c0 + j, v]));
			});
			sel = { ar: R.r0, ac: R.c0, fr: R.r0 + block.length - 1, fc: R.c0 + maxC - 1 };
		}
		this.commit(applyEdits(this.grid, edits), { sel });
	}

	// ------------------------------------------------------------------ menus

	private fillInsertItems(menu: Menu) {
		menu.addItem((i) => i.setTitle("Insert row above").setIcon("arrow-up-from-line").onClick(() => this.insertRowsAt("above")));
		menu.addItem((i) => i.setTitle("Insert row below").setIcon("arrow-down-from-line").onClick(() => this.insertRowsAt("below")));
		menu.addItem((i) => i.setTitle("Insert column left").setIcon("arrow-left-from-line").onClick(() => this.insertColsAt("left")));
		menu.addItem((i) => i.setTitle("Insert column right").setIcon("arrow-right-from-line").onClick(() => this.insertColsAt("right")));
	}

	private fillDeleteItems(menu: Menu) {
		menu.addItem((i) => i.setTitle("Delete selected row(s)").setIcon("trash-2").onClick(() => this.deleteSelectedRows()));
		menu.addItem((i) => i.setTitle("Delete selected column(s)").setIcon("trash-2").onClick(() => this.deleteSelectedCols()));
	}

	private fillSortItems(menu: Menu, col: number) {
		const name = colLabel(col);
		menu.addItem((i) => i.setTitle(`Sort column ${name} A → Z`).setIcon("arrow-up").onClick(() => this.setSortSpec({ col, dir: "asc" })));
		menu.addItem((i) => i.setTitle(`Sort column ${name} Z → A`).setIcon("arrow-down").onClick(() => this.setSortSpec({ col, dir: "desc" })));
		if (this.sort) {
			menu.addItem((i) => i.setTitle("Clear sort").setIcon("x").onClick(() => this.setSortSpec(null)));
			menu.addItem((i) => i.setTitle("Apply sort to file").setIcon("save").onClick(() => this.applySortToFile()));
		}
	}

	private fillConvertItems(menu: Menu) {
		menu.addItem((i) => i.setTitle("Convert decimals in selection: 1,5 → 1.5").setIcon("replace").onClick(() => this.convertSelection(",", ".")));
		menu.addItem((i) => i.setTitle("Convert decimals in selection: 1.5 → 1,5").setIcon("replace").onClick(() => this.convertSelection(".", ",")));
	}

	private insertMenu(): Menu {
		const m = new Menu();
		this.fillInsertItems(m);
		return m;
	}

	private deleteMenu(): Menu {
		const m = new Menu();
		m.addItem((i) => i.setTitle("Clear contents").setIcon("eraser").onClick(() => this.clearSelection()));
		this.fillDeleteItems(m);
		return m;
	}

	private sortMenu(col: number): Menu {
		const m = new Menu();
		this.fillSortItems(m, col);
		return m;
	}

	private settingsMenu(): Menu {
		const m = new Menu();
		for (const [value, label] of DELIMITER_LABELS) {
			const optionDelim = this.plugin.fileOptions(this.file?.path).delimiter;
			const checked = value === "auto" ? !optionDelim : optionDelim === value;
			m.addItem((i) => i.setTitle(`Delimiter: ${label}`).setChecked(checked).onClick(() => void this.setDelimiter(value)));
		}
		m.addSeparator();
		for (const [value, label] of DECIMAL_LABELS) {
			const optionDec = this.plugin.fileOptions(this.file?.path).decimal;
			const checked = value === "auto" ? !optionDec : optionDec === value;
			m.addItem((i) => i.setTitle(`Decimal: ${label}`).setChecked(checked).onClick(() => void this.setDecimalOption(value)));
		}
		m.addSeparator();
		m.addItem((i) =>
			i.setTitle("Freeze first row").setChecked(this.freeze).onClick(async () => {
				this.freeze = !this.freeze;
				await this.plugin.updateFileOptions(this.file?.path, { freeze: this.freeze });
				this.order = computeOrder(this.grid, this.sort, this.freeze, this.decimal);
				this.renderAll();
			})
		);
		m.addSeparator();
		this.fillConvertItems(m);
		return m;
	}

	/** Re-read the data with another delimiter (the file itself only changes when you edit). */
	private async setDelimiter(value: string) {
		this.commitEditIfAny();
		const text = serializeCsv(this.grid, this.delimiter, "\n");
		await this.plugin.updateFileOptions(this.file?.path, { delimiter: value === "auto" ? undefined : value });
		const next = value === "auto" ? this.resolveDelimiter(text, undefined) : value;
		this.delimiter = next;
		this.grid = normalize(parseCsv(text, next));
		this.past = [];
		this.future = [];
		this.sort = null;
		this.colW = [];
		this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
		this.decimal = this.resolveDecimal(this.plugin.fileOptions(this.file?.path).decimal);
		this.afterGridChange(false);
		this.autoFitColumns();
		this.renderAll();
	}

	private async setDecimalOption(value: string) {
		await this.plugin.updateFileOptions(this.file?.path, { decimal: value === "auto" ? undefined : (value as Decimal) });
		this.decimal = value === "auto" ? detectDecimal(this.grid) : (value as Decimal);
		this.order = computeOrder(this.grid, this.sort, this.freeze, this.decimal);
		this.renderAll();
	}

	// ------------------------------------------------------------------ statistics

	openStats() {
		this.commitEditIfAny();
		const R = this.rect();
		const hasSelection = R.r0 !== R.r1 || R.c0 !== R.c1;
		const headerRow = this.freeze ? 0 : -1;
		new StatsModal(this.app, {
			title: `Statistics · ${this.file ? this.file.name : ""}`,
			hasSelection,
			decimal: this.decimal,
			compute: (scope: StatsScope) => {
				const cols: number[] = [];
				const from = scope === "selection" ? R.c0 : 0;
				const to = scope === "selection" ? R.c1 : this.nCols() - 1;
				for (let c = from; c <= to; c++) cols.push(c);
				const rows: number[] = [];
				if (scope === "selection") {
					for (let r = R.r0; r <= R.r1; r++) if (this.order[r] !== headerRow) rows.push(this.order[r]);
				} else {
					for (let r = 0; r < this.grid.length; r++) if (r !== headerRow) rows.push(r);
				}
				const names = cols.map((c) => {
					const h = headerRow === 0 ? this.grid[0][c] : "";
					return h ? `${colLabel(c)} · ${h}` : colLabel(c);
				});
				return columnStats(this.grid, cols, rows, names, this.decimal);
			},
		}).open();
	}

	// ------------------------------------------------------------------ find & replace

	private buildSearch(root: HTMLElement) {
		const bar = (this.searchEl = root.createDiv({ cls: "c4-search" }));
		bar.hide();
		const find = bar.createDiv({ cls: "c4-search-row" });
		this.findInput = find.createEl("input", { type: "text", placeholder: "Find", cls: "c4-search-input" });
		this.countEl = find.createSpan({ cls: "c4-count", text: "" });
		this.button(find, "chevron-up", "Previous match (Shift+Enter)", () => this.gotoMatch(-1));
		this.button(find, "chevron-down", "Next match (Enter)", () => this.gotoMatch(1));
		const cs = this.button(find, "case-sensitive", "Match case", () => {
			this.matchCase = !this.matchCase;
			cs.toggleClass("is-active", this.matchCase);
			this.computeMatches(true);
		});
		this.button(find, "x", "Close (Esc)", () => this.closeSearch());

		const rep = bar.createDiv({ cls: "c4-search-row" });
		this.replaceInput = rep.createEl("input", { type: "text", placeholder: "Replace with", cls: "c4-search-input" });
		const b1 = rep.createEl("button", { text: "Replace", cls: "c4-btn" });
		const b2 = rep.createEl("button", { text: "Replace all", cls: "c4-btn" });
		b1.addEventListener("click", () => this.replaceCurrent());
		b2.addEventListener("click", () => this.replaceAll());

		this.findInput.addEventListener("input", () => this.computeMatches(true));
		const keys = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeSearch();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (e.target === this.replaceInput) this.replaceCurrent();
				else this.gotoMatch(e.shiftKey ? -1 : 1);
			}
		};
		this.findInput.addEventListener("keydown", keys);
		this.replaceInput.addEventListener("keydown", keys);
	}

	openSearch(focusReplace: boolean) {
		this.commitEditIfAny();
		this.searchOpen = true;
		this.searchEl.show();
		const R = this.rect();
		if (R.r0 === R.r1 && R.c0 === R.c1) {
			const v = this.cell(R.r0, R.c0);
			if (v && !this.findInput.value && v.length < 60) this.findInput.value = v;
		}
		this.computeMatches(true);
		(focusReplace ? this.replaceInput : this.findInput).focus();
		this.findInput.select();
	}

	private closeSearch() {
		this.searchOpen = false;
		this.searchEl.hide();
		this.matches = [];
		this.matchSet.clear();
		this.matchIdx = -1;
		this.refreshSelection();
		this.scrollEl.focus({ preventScroll: true });
	}

	private computeMatches(jump: boolean) {
		const q = this.findInput.value;
		this.matches = [];
		this.matchSet.clear();
		this.matchIdx = -1;
		if (q !== "") {
			const needle = this.matchCase ? q : q.toLowerCase();
			for (let dr = 0; dr < this.order.length; dr++) {
				const row = this.grid[this.order[dr]];
				for (let c = 0; c < row.length; c++) {
					const v = row[c];
					if (v === "") continue;
					if ((this.matchCase ? v : v.toLowerCase()).includes(needle)) {
						this.matches.push([dr, c]);
						this.matchSet.add(this.order[dr] + ":" + c);
					}
				}
			}
			if (this.matches.length) {
				const { ar, ac } = this.sel;
				let idx = this.matches.findIndex(([r, c]) => r > ar || (r === ar && c >= ac));
				if (idx < 0) idx = 0;
				this.matchIdx = idx;
			}
		}
		this.updateCount();
		if (jump && this.matchIdx >= 0) {
			const [r, c] = this.matches[this.matchIdx];
			this.sel = { ar: r, ac: c, fr: r, fc: c };
			this.reveal(r, c);
		}
		this.refreshSelection();
	}

	/** Keep the "current match" marker in sync when the user moves the selection. */
	private syncMatchToSelection() {
		const { ar, ac } = this.sel;
		const idx = this.matches.findIndex(([r, c]) => r === ar && c === ac);
		if (idx >= 0 && idx !== this.matchIdx) {
			this.matchIdx = idx;
			this.updateCount();
			this.refreshSelection();
		}
	}

	private updateCount() {
		const n = this.matches.length;
		this.countEl.setText(this.findInput.value === "" ? "" : n ? `${this.matchIdx + 1}/${n}` : "No results");
	}

	private gotoMatch(dir: 1 | -1) {
		const n = this.matches.length;
		if (!n) return;
		this.matchIdx = (this.matchIdx + dir + n) % n;
		const [r, c] = this.matches[this.matchIdx];
		this.updateCount();
		this.setSel(r, c);
	}

	private replaceRegex(): RegExp {
		return new RegExp(escapeRegExp(this.findInput.value), this.matchCase ? "g" : "gi");
	}

	private replaceCurrent() {
		if (this.matchIdx < 0 || !this.matches.length) return;
		const [r, c] = this.matches[this.matchIdx];
		const rep = this.replaceInput.value;
		const nv = this.cell(r, c).replace(this.replaceRegex(), () => rep);
		this.commit(applyEdits(this.grid, [[this.dataRow(r), c, nv]]));
		if (this.matches.length) {
			this.matchIdx = Math.min(this.matchIdx, this.matches.length - 1);
			const [nr, nc] = this.matches[this.matchIdx];
			this.updateCount();
			this.setSel(nr, nc);
		}
	}

	private replaceAll() {
		if (!this.matches.length) return;
		const rep = this.replaceInput.value;
		const re = this.replaceRegex();
		const edits: Array<[number, number, string]> = this.matches.map(([r, c]) => [
			this.dataRow(r),
			c,
			this.cell(r, c).replace(re, () => rep),
		]);
		this.commit(applyEdits(this.grid, edits));
		new Notice(`Replaced in ${edits.length} cell${edits.length > 1 ? "s" : ""}`);
	}
}

