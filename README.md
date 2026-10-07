# CSV4Obsidian

A spreadsheet-style editor for `.csv` and `.tsv` files in Obsidian (desktop and mobile).
Open a file and edit it like a spreadsheet: the file is only rewritten when you actually change something.

## Features

- **Content bar** – like Excel's formula bar: shows the reference of the active cell (`B12`, `B3:D9`, `B:D`, `3:5`)
  and its *full* content across the whole width. Click in it to edit the cell (`Enter` validates, `Esc` cancels,
  `Alt+Enter` adds a line break); the ⌄ button expands it for long or multi-line text.
- **Move rows & columns** – a small grip appears on a column header / row number (always visible once the column or row
  is selected, and on mobile). Drag it to move the column or row; a line shows where it will land, the table scrolls near
  the edges, and everything selected moves together. A plain click on the grip selects the column/row. Undoable.
  Rows can't be moved while a sort is active (apply or clear it first) and the frozen first row stays put.
- **Edit in place** – double-click, `Enter` or `F2` to edit a cell; just start typing to replace it.
  `Enter` / `Tab` commit and move (add `Shift` to go backwards). `Esc` cancels.
- **Select like a spreadsheet** – click a column letter or a row number to select the whole column/row,
  drag or `Shift`+click to extend, click the top-left corner or press `Ctrl/Cmd+A` for everything.
  Selected rows/columns are highlighted, and the status bar shows Count / Sum / Average of the selection.
- **Select all, then delete** – `Delete` clears the selected cells. Clearing or deleting the *whole table*
  asks for confirmation (can be disabled in settings), and everything is undoable.
- **Sort by column** – click the arrow in a column header: ascending → descending → off.
  Numbers are sorted numerically, empty cells always go last, the frozen first row stays on top.
  Sorting is a *view*: the file is untouched until you choose **Sort → Apply sort to file**.
- **Statistics** – the **Statistics** button shows, per column: count, empty, unique, numeric count,
  sum, mean, median, min, max, standard deviation and most frequent value, for whole columns or for the
  selected cells only. Copy the result as TSV.
- **Find & replace** – `Ctrl/Cmd+F` (`Ctrl/Cmd+H` for replace). All matches are highlighted, the current one stands out,
  with next/previous, match case, replace and replace all.
- **Undo / redo** – `Ctrl/Cmd+Z`, `Ctrl/Cmd+Y` (or `Ctrl/Cmd+Shift+Z`), 200 steps.
- **Delimiter & decimal separator** – delimiter is auto-detected (`,` `;` tab `|`); decimal separator
  (`1.5` vs `1,5`) too. Both can be forced per file from the ⚙ menu, and **Convert decimals in selection**
  rewrites `1,5` ⇄ `1.5`.
- **Insert / delete rows and columns** from the toolbar or the right-click menu (as many as are selected).
- **Copy / cut / paste** – `Ctrl/Cmd+C/X/V`, toolbar buttons (also on mobile) and the right-click menu. Compatible with Excel,
  Google Sheets and LibreOffice (tab-separated). Pasting a single value over a selection fills it; a block grows the table if needed.
- **Large files** – only the visible rows are rendered; columns are sized to their content (64–480 px), drag a
  column border to resize it, double-click it to fit.
- Frozen first row (header), row zebra striping, right-aligned numbers.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Arrows, `Tab`, `Home`, `End`, `PageUp/Down` | Move (`Shift` extends, `Ctrl/Cmd` jumps to the edge) |
| `Enter`, `F2`, or start typing | Edit the active cell |
| `Delete`, `Backspace` | Clear selected cells |
| `Cmd/Ctrl` + `Backspace` | Delete the selected row(s) / column(s) when selected in full (otherwise clears) |
| `Ctrl/Cmd` + `A` / `C` / `X` / `V` | Select all / copy / cut / paste |
| `Ctrl/Cmd` + `Z` / `Y` | Undo / redo |
| `Ctrl/Cmd` + `F` / `H` | Find / find & replace |

## Notes

- The file is saved automatically (like any Obsidian note). Cells that need it are re-quoted on save;
  line endings (LF/CRLF), a byte-order mark and the trailing newline are preserved.
- Changing the delimiter from the menu re-reads the data with the new delimiter; the file is only
  rewritten once you edit.

## Install (manual / BRAT)

Build with `npm install && npm run build`, then copy `main.js`, `manifest.json` and `styles.css` to
`<vault>/.obsidian/plugins/csv4obsidian/`. Or add this repository with the BRAT plugin once a release exists.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production bundle
npm test         # unit tests for the table logic and a DOM test of the view
```

## Credits

Inspired by [CSV Lite](https://github.com/LIUBINfighter/csv-lite) and
[Omni Viewer](https://github.com/battlecook/omni-viewer-obsidian) (both MIT). See `THIRD_PARTY_NOTICES.md`.

MIT licensed.
