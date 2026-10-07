import { App, PluginSettingTab, Setting } from "obsidian";
import type Csv4ObsidianPlugin from "./main";

export type DecimalSetting = "auto" | "." | ",";

export interface FileOptions {
	delimiter?: string;
	decimal?: "." | ",";
	freeze?: boolean;
}

export interface Csv4Settings {
	/** "auto" or an actual delimiter character */
	delimiter: string;
	decimal: DecimalSetting;
	freezeFirstRow: boolean;
	confirmBulk: boolean;
	files: Record<string, FileOptions>;
}

export const DEFAULT_SETTINGS: Csv4Settings = {
	delimiter: "auto",
	decimal: "auto",
	freezeFirstRow: true,
	confirmBulk: true,
	files: {},
};

export const DELIMITER_LABELS: Array<[string, string]> = [
	["auto", "Auto-detect"],
	[",", "Comma ( , )"],
	[";", "Semicolon ( ; )"],
	["\t", "Tab"],
	["|", "Pipe ( | )"],
];

export const DECIMAL_LABELS: Array<[DecimalSetting, string]> = [
	["auto", "Auto-detect"],
	[".", "Dot ( 1.5 )"],
	[",", "Comma ( 1,5 )"],
];

export class Csv4SettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: Csv4ObsidianPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Column delimiter")
			.setDesc("Used when opening files. You can also change it per file from the toolbar.")
			.addDropdown((d) => {
				DELIMITER_LABELS.forEach(([v, l]) => d.addOption(v, l));
				d.setValue(this.plugin.settings.delimiter).onChange(async (v) => {
					this.plugin.settings.delimiter = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Decimal separator")
			.setDesc("Used for sorting and statistics. Auto-detect looks at the numbers in the file.")
			.addDropdown((d) => {
				DECIMAL_LABELS.forEach(([v, l]) => d.addOption(v, l));
				d.setValue(this.plugin.settings.decimal).onChange(async (v) => {
					this.plugin.settings.decimal = v as DecimalSetting;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Freeze first row")
			.setDesc("Keep the first row pinned at the top and exclude it from sorting and statistics.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.freezeFirstRow).onChange(async (v) => {
					this.plugin.settings.freezeFirstRow = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Confirm whole-table deletions")
			.setDesc("Ask before clearing or deleting every row or column. Everything stays undoable.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.confirmBulk).onChange(async (v) => {
					this.plugin.settings.confirmBulk = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
