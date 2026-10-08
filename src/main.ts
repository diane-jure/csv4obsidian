import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CsvView, VIEW_TYPE } from "./view";
import { Csv4Settings, Csv4SettingTab, DEFAULT_SETTINGS, FileOptions } from "./settings";

export default class Csv4ObsidianPlugin extends Plugin {
	settings!: Csv4Settings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CsvView(leaf, this));
		this.registerExtensions(["csv", "tsv"], VIEW_TYPE);
		this.addSettingTab(new Csv4SettingTab(this.app, this));

		this.addCommand({
			id: "new-csv-file",
			name: "Create new CSV file",
			callback: () => void this.createCsv(""),
		});
		this.addCommand({
			id: "find",
			name: "Find and replace in table",
			checkCallback: (checking) => this.withView(checking, (v) => v.openSearch(true)),
		});
		this.addCommand({
			id: "statistics",
			name: "Show column statistics",
			checkCallback: (checking) => this.withView(checking, (v) => v.openStats()),
		});
		this.addCommand({
			id: "undo",
			name: "Undo table edit",
			checkCallback: (checking) => this.withView(checking, (v) => v.undo()),
		});
		this.addCommand({
			id: "redo",
			name: "Redo table edit",
			checkCallback: (checking) => this.withView(checking, (v) => v.redo()),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) =>
					item
						.setTitle("New CSV file")
						.setIcon("table")
						.onClick(() => {
							const i = file.path.lastIndexOf("/");
							void this.createCsv(i > 0 ? file.path.substring(0, i) : "");
						})
				);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const opts = this.settings.files[oldPath];
				if (opts) {
					delete this.settings.files[oldPath];
					this.settings.files[file.path] = opts;
					void this.saveSettings();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.settings.files[file.path]) {
					delete this.settings.files[file.path];
					void this.saveSettings();
				}
			})
		);
	}

	private withView(checking: boolean, fn: (v: CsvView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(CsvView);
		if (!view) return false;
		if (!checking) fn(view);
		return true;
	}

	fileOptions(path: string | undefined): FileOptions {
		return (path && this.settings.files[path]) || {};
	}

	async updateFileOptions(path: string | undefined, patch: Partial<FileOptions>) {
		if (!path) return;
		const next: FileOptions = { ...this.settings.files[path], ...patch };
		(Object.keys(next) as Array<keyof FileOptions>).forEach((k) => {
			if (next[k] === undefined) delete next[k];
		});
		if (Object.keys(next).length) this.settings.files[path] = next;
		else delete this.settings.files[path];
		await this.saveSettings();
	}

	private async createCsv(folder: string) {
		let name = "new.csv";
		let i = 0;
		const path = () => (folder ? `${folder}/${name}` : name);
		while (this.app.vault.getAbstractFileByPath(path())) {
			i++;
			name = `new-${i}.csv`;
		}
		try {
			const file = await this.app.vault.create(path(), "");
			if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
		} catch (e) {
			console.error(e);
			new Notice("Could not create the CSV file");
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.files = this.settings.files || {};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
