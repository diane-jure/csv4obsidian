// Minimal stand-in for the parts of the Obsidian API the view uses.
declare global {
	interface HTMLElement {
		createEl(tag: string, o?: any): HTMLElement;
		createDiv(o?: any): HTMLElement;
		createSpan(o?: any): HTMLElement;
		empty(): void;
		addClass(...c: string[]): void;
		removeClass(...c: string[]): void;
		toggleClass(c: string, on: boolean): void;
		hide(): void;
		show(): void;
		setText(t: string): void;
	}
}
export function installDomHelpers(win: any) {
	const P = win.HTMLElement.prototype;
	P.createEl = function (tag: string, o: any = {}) {
		const el = win.document.createElement(tag);
		if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
		if (o.text !== undefined) el.textContent = o.text;
		if (o.type) el.type = o.type;
		if (o.value !== undefined) el.value = o.value;
		if (o.placeholder) el.placeholder = o.placeholder;
		if (o.attr) for (const k in o.attr) el.setAttribute(k, o.attr[k]);
		this.appendChild(el);
		return el;
	};
	P.createDiv = function (o?: any) { return this.createEl("div", o); };
	P.createSpan = function (o?: any) { return this.createEl("span", o); };
	P.empty = function () { this.replaceChildren(); };
	P.addClass = function (...c: string[]) { this.classList.add(...c); };
	P.removeClass = function (...c: string[]) { this.classList.remove(...c); };
	P.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
	P.hide = function () { this.style.display = "none"; };
	P.show = function () { this.style.display = ""; };
	P.setText = function (t: string) { this.textContent = t; };
}

export class Notice { constructor(public msg: string) { (globalThis as any).__notices?.push(msg); } }
export class Modal {
	contentEl: HTMLElement; modalEl: HTMLElement;
	constructor(public app: any) { this.contentEl = document.createElement("div"); this.modalEl = document.createElement("div"); }
	open() { (globalThis as any).__modals?.push(this); (this as any).onOpen?.(); }
	close() { (this as any).onClose?.(); }
}
export class Menu {
	items: any[] = [];
	addItem(f: (i: any) => void) {
		const it: any = { title: "", checked: false, click: () => {} };
		it.setTitle = (t: string) => { it.title = t; return it; };
		it.setIcon = () => it; it.setChecked = (c: boolean) => { it.checked = c; return it; };
		it.onClick = (fn: any) => { it.click = fn; return it; };
		f(it); this.items.push(it); return this;
	}
	addSeparator() { return this; }
	showAtMouseEvent() { (globalThis as any).__menus?.push(this); }
}
export class TextFileView {
	file: any = { path: "t.csv", basename: "t", name: "t.csv", extension: "csv" };
	contentEl: HTMLElement = document.createElement("div");
	app: any = {};
	saves = 0;
	constructor(public leaf: any) {}
	requestSave() { this.saves++; }
	registerDomEvent(el: any, type: string, fn: any) { el.addEventListener(type, fn); }
}
export class PluginSettingTab {}
export class Setting {}
export class Plugin {}
export class TFile {}
export class WorkspaceLeaf {}
export function setIcon() {}
