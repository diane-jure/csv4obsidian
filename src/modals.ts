import { App, Modal, Notice } from "obsidian";
import { ColStats } from "./stats";
import { Decimal, formatNumber } from "./ops";

export class ConfirmModal extends Modal {
	constructor(app: App, private message: string, private confirmLabel: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		const ok = row.createEl("button", { text: this.confirmLabel, cls: "mod-warning" });
		const cancel = row.createEl("button", { text: "Cancel" });
		ok.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
		cancel.addEventListener("click", () => this.close());
		ok.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}

export type StatsScope = "all" | "selection";

export interface StatsModalOptions {
	compute: (scope: StatsScope) => ColStats[];
	hasSelection: boolean;
	decimal: Decimal;
	title: string;
}

export class StatsModal extends Modal {
	private statsScope: StatsScope;
	private bodyEl!: HTMLElement;
	private stats: ColStats[] = [];

	constructor(app: App, private opts: StatsModalOptions) {
		super(app);
		this.statsScope = opts.hasSelection ? "selection" : "all";
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("c4-stats-modal");
		contentEl.createEl("h3", { text: this.opts.title });

		const bar = contentEl.createDiv({ cls: "c4-stats-bar" });
		const select = bar.createEl("select", { cls: "dropdown" });
		select.createEl("option", { text: "Whole columns", value: "all" });
		const sel = select.createEl("option", { text: "Selected cells only", value: "selection" });
		if (!this.opts.hasSelection) sel.disabled = true;
		select.value = this.statsScope;
		select.addEventListener("change", () => {
			this.statsScope = select.value as StatsScope;
			this.render();
		});
		const copy = bar.createEl("button", { text: "Copy as TSV" });
		copy.addEventListener("click", () => {
			navigator.clipboard
				.writeText(this.toTsv())
				.then(() => new Notice("Statistics copied"))
				.catch(() => new Notice("Could not copy"));
		});

		this.bodyEl = contentEl.createDiv({ cls: "c4-stats-body" });
		this.render();
	}

	private header(): string[] {
		return ["Column", "Count", "Empty", "Unique", "Numeric", "Sum", "Mean", "Median", "Min", "Max", "Std dev", "Most frequent"];
	}

	private fmt(n: number | null): string {
		return n === null ? "–" : formatNumber(n, this.opts.decimal);
	}

	private rowCells(s: ColStats): string[] {
		return [
			s.name,
			String(s.count),
			String(s.empty),
			String(s.unique),
			String(s.numeric),
			this.fmt(s.sum),
			this.fmt(s.mean),
			this.fmt(s.median),
			this.fmt(s.min),
			this.fmt(s.max),
			this.fmt(s.stdev),
			s.top === null ? "–" : `${s.top} (${s.topCount})`,
		];
	}

	private render() {
		this.stats = this.opts.compute(this.statsScope);
		this.bodyEl.empty();
		const table = this.bodyEl.createEl("table", { cls: "c4-stats-table" });
		const head = table.createEl("thead").createEl("tr");
		this.header().forEach((h, i) => head.createEl("th", { text: h, cls: i === 0 ? "" : "c4-stats-num" }));
		const body = table.createEl("tbody");
		for (const s of this.stats) {
			const tr = body.createEl("tr");
			this.rowCells(s).forEach((v, i) => {
				const td = tr.createEl("td", { text: v });
				if (i > 0 && i < 11) td.addClass("c4-stats-num");
			});
		}
	}

	private toTsv(): string {
		const lines = [this.header().join("\t")];
		for (const s of this.stats) lines.push(this.rowCells(s).join("\t"));
		return lines.join("\n");
	}

	onClose() {
		this.contentEl.empty();
	}
}
