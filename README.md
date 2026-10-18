# PDF Phoenix

View, annotate and fill in PDF files right inside VS Code, and save your changes straight into the file. Built on Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), with an engine that keeps itself up to date.

## A pdf.js engine that stays current on its own

Every PDF you open is read by pdf.js: a large, complex program parsing a file that could have come from anyone. Like any such software it occasionally has security flaws, which Mozilla fixes in new pdf.js releases. In 2024, for example, a pdf.js flaw (CVE-2024-4367) let a crafted PDF run code as soon as it was opened.

PDF extensions for VS Code typically bundle a fixed pdf.js that only changes when the extension itself is republished, so a fix reaches you only if and when its author ships an update; several widely installed ones still run pdf.js builds from 2022. PDF Phoenix doesn't wait on that:

- **Ships with the latest pdf.js** (6.4.299 in this release).
- **Updates itself.** About once a day it checks Mozilla's releases and offers any newer version within the same major version. It never jumps to a new major version on its own.
- **Verifies every download** against the SHA-256 digest GitHub publishes for it, before using it.
- **Puts you in control.** Pick any release, or go back to the built-in one, from the Command Palette at any time. Open PDFs switch over right away. Need to stay on one version? A setting keeps it even after PDF Phoenix updates.

So a pdf.js fix reaches you as soon as Mozilla ships it, not whenever this extension is next updated. Details in [Keeping the PDF engine up to date](#keeping-the-pdf-engine-up-to-date).

## Everything else it does

- **Annotations that really save.** Highlight, draw, add text, images and stamps, then press `Ctrl/Cmd+S`: the changes are written into the PDF itself, not a sidecar file. It works like any other VS Code editor, with the unsaved-changes dot, **File: Revert File**, and hot exit backups, so unsaved annotations even survive a restart or crash. Most VS Code PDF extensions are view-only, and the few that save don't hook into VS Code's own save like this.
- **Fill in PDF forms** and save the values into the file.
- **Export and import annotations.** Turn every highlight, note, text box and drawing into a Markdown summary with the highlighted text quoted, or move annotations between PDFs and other PDF tools (Acrobat, Foxit, PDF-XChange) as standard XFDF files. Other VS Code PDF extensions generally offer neither.
- **Picks up where you left off.** Reopen a PDF on the same page, at the same zoom and scroll position.
- **Matches your VS Code theme.** The toolbar, sidebar and dialogs follow your light or dark theme as you switch, and the pages themselves can take on your editor's colors for comfortable reading in a dark theme (see [Dark themes](#dark-themes)).
- **Speaks your language.** The viewer's toolbar and menus follow VS Code's display language.
- **Keeps your shortcuts.** pdf.js normally grabs `Ctrl/Cmd+P` and `Ctrl/Cmd+Shift+P` to print, popping a "Preparing to print" overlay over Quick Open and the Command Palette. PDF Phoenix leaves both to VS Code; printing is still one click away on the toolbar.
- **Opens the way you want.** Default zoom, sidebar, page layout and pointer tool, and the annotation tools' starting colors and sizes, are all settings (see [Settings](#settings)).
- **Smooth with large PDFs.** Files are parsed in pdf.js's background worker and passed to the viewer as binary data, so even a 40 MB PDF opens and saves in a fraction of a second.
- **Never a blank editor.** If a PDF can't be opened, PDF Phoenix says why, and when a downloaded pdf.js is the cause, offers to switch back to the built-in one.
- **Works in Restricted Mode.** PDFs in untrusted folders open in the viewer too, with PDF JavaScript switched off (see [Restricted Mode](#restricted-mode)).

## Opening a PDF

Just open any `.pdf` file. PDF Phoenix is the default editor for PDFs, so a normal click in the Explorer opens it in the viewer. To switch back and forth with another editor, use **View: Reopen Editor With...**

Each PDF reopens where you left it: page, zoom, scroll position, rotation, sidebar panel, and page layout. This is remembered per workspace for the 200 most recently viewed PDFs. Turn it off with `pdfPhoenix.rememberViewState`, and every PDF opens with the defaults from [Settings](#settings) instead.

## Editing and saving annotations and forms

1. Pick a tool from the viewer toolbar: highlight, text, draw, or image/stamp. To fill in a form, just type into its fields.
2. Make your marks. The editor tab shows a dot to indicate unsaved changes.
3. Save with `Ctrl/Cmd+S`. The annotations and form values are written into the PDF.

Undo and redo work inside the viewer with `Ctrl/Cmd+Z` and `Ctrl/Cmd+Y`. To throw away all unsaved edits, run **File: Revert File**.

> The unsaved-changes dot clears when you save or revert. Undoing edits inside the viewer reverts the content, but the dot stays until you save or revert, so you never lose track of whether what's on disk matches what you see.

The highlight, draw and text tools start with the colors and sizes in the `pdfPhoenix.annotations.*` settings. You can still change them for each annotation from the toolbar.

If the PDF changes on disk while it's open, PDF Phoenix reloads it, keeping your place. If you have unsaved annotations at that moment, it keeps them and tells you instead. Saving then overwrites the file on disk with your version, and **File: Revert File** (or the notification's **Reload from Disk**) switches to the version on disk.

## Exporting and importing annotations

All of these are in the Command Palette, the PDF editor's `...` menu, and the Explorer's right-click menu on a PDF. Annotations you haven't saved yet are always included.

**PDF Phoenix: Export Annotations to Markdown** opens a new Markdown document with every highlight, underline, strikethrough, note, text box, drawing, stamp and shape, grouped by page, each with its color, author and date where the PDF records them. Highlights show the text they cover, with their notes underneath. It's for reading: study notes, a summary of a reviewer's comments, something to paste elsewhere. Nothing is written to disk until you save it.

**PDF Phoenix: Export Annotations as XFDF…** saves the annotations as an `.xfdf` file: XFDF (ISO 19444-1) is the standard annotation-exchange format that Adobe Acrobat and most PDF tools import and export. It keeps positions, shapes, colors, notes, authors and dates, so annotations can travel without the PDF itself, for example to a colleague who has their own copy.

**PDF Phoenix: Import Annotations from XFDF…** adds the annotations in an `.xfdf` file (from PDF Phoenix or another PDF tool) to the open PDF. They arrive as unsaved edits, exactly as if you'd drawn them: review them, then save with `Ctrl/Cmd+S` to keep them, or undo or revert to drop them. If the file was made for a different PDF (its document ID doesn't match), you're asked first, since the annotations may not line up.

Import can create the annotation types pdf.js's editor can: **highlights, drawings and text boxes**, each with its note. Other types in the file (sticky notes, underlines, shapes, stamps) can't be created in the viewer yet; the import tells you how many of each were left out, rather than dropping them silently.

## Dark themes

By default the viewer's toolbar, sidebar, and dialogs match VS Code: light in a light theme, dark in a dark or high contrast theme. Set `pdfPhoenix.viewerTheme` to `light` or `dark` to pin one.

Pages keep the document's own colors unless you set `pdfPhoenix.pageColors`:

- `match-dark-themes`: while VS Code uses a dark theme, pages are drawn in your editor's background and text colors.
- `match-all-themes`: pages always use your editor's colors.

Recoloring uses pdf.js's high contrast rendering, which draws everything on the page in tones between those two colors, so photos and colored diagrams lose their color. It only changes what you see: highlights and drawings you save keep the colors you picked.

pdf.js sets page colors when it builds the viewer, so when a theme switch or setting change calls for different colors, an open PDF reloads itself at the same page, zoom, and scroll position. If it has unsaved changes, it waits until you save or revert, so nothing is lost.

## Restricted Mode

PDF Phoenix works in VS Code's Restricted Mode (untrusted folders): PDFs open in the viewer, and you can annotate and save them as usual. The one difference is that JavaScript embedded in a PDF does not run, so interactive forms that rely on scripts (for example, fields that calculate totals or validate input) won't do so. pdf.js already runs that JavaScript in a sandbox; turning it off in untrusted folders is an extra layer. Once you trust the folder, open PDFs reload with it on, or after you save or revert if they have unsaved changes.

## Keeping the PDF engine up to date

PDF Phoenix always ships with a bundled, tested version of pdf.js. On top of that, it can use a newer one you download at runtime, so a pdf.js security fix reaches you as soon as Mozilla ships it, not whenever PDF Phoenix next gets published:

- **Automatic checks.** About once a day, PDF Phoenix checks Mozilla's releases for a newer version *within the same major version* and asks before downloading. It never jumps to a new major version on its own, because a major release could change internals that annotation-saving and the shortcut handling rely on. Turn this off with the `pdfPhoenix.pdfjs.autoCheckForUpdates` setting.
- **Commands** (open the Command Palette and type "PDF Phoenix"):
  - **PDF Phoenix: Check for pdf.js Updates** checks now for the latest release in the current major version.
  - **PDF Phoenix: Choose pdf.js Version...** lets you pick any release from Mozilla's history, or return to the built-in version. Choosing a different major version asks for confirmation first.
  - **PDF Phoenix: Use Built-in pdf.js Version** goes back to the version that shipped with the extension.

Every download is checked before anything is extracted: its size and SHA-256 digest must match what GitHub publishes for that release. GitHub only publishes digests for releases from mid-2025 on, so for older releases PDF Phoenix can check the size only, and asks before installing one. If the release details can't be fetched at all, nothing is installed. A downloaded copy is then validated before it's used, and anything that fails to download, verify or validate leaves your current engine untouched.

Downloaded versions are stored per-user, each in its own folder. When a PDF Phoenix update brings a built-in pdf.js that is the same as or newer than your downloaded one, the built-in version takes over and the old download is removed. To stay on a version you chose even then, turn on `pdfPhoenix.pdfjs.keepDownloadedVersion` (and turn off `pdfPhoenix.pdfjs.autoCheckForUpdates` so you aren't offered newer releases). Switching versions applies to open PDFs right away, in every VS Code window (or, for any with unsaved changes, once you save or revert them). A replaced version's folder is removed once no open PDF uses it any more; since PDFs open in other windows can't be tracked, it's kept for up to a week first.

If a PDF can't be opened, PDF Phoenix says why instead of leaving the editor blank. When that happens on a downloaded pdf.js (for example, one needing a newer VS Code than yours), the message offers to switch back to the built-in version.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pdfPhoenix.rememberViewState` | `true` | Reopen each PDF where you left off. When on, the opening defaults below apply to PDFs you haven't opened before. |
| `pdfPhoenix.defaultZoom` | `page-fit` | Zoom a PDF opens at: `auto`, `page-fit`, `page-width`, or `page-actual`. |
| `pdfPhoenix.defaultSidebar` | `outline` | Sidebar panel a PDF opens with: `none`, `thumbnails`, or `outline`. (Outline falls back to thumbnails when a PDF has no bookmarks.) |
| `pdfPhoenix.defaultScrollMode` | `document` | Page layout for scrolling: `document` (what the PDF asks for, otherwise vertical), `vertical`, `horizontal`, `wrapped`, or `page`. |
| `pdfPhoenix.defaultSpreadMode` | `document` | Single pages or two-page spreads: `document` (what the PDF asks for, otherwise single), `none`, `odd`, or `even`. |
| `pdfPhoenix.defaultCursorTool` | `select` | Pointer tool a PDF opens with: `select` (text selection) or `hand`. |
| `pdfPhoenix.viewerTheme` | `match-vscode` | Color scheme of the toolbar, sidebar, and dialogs: `match-vscode`, `light`, or `dark`. Follows theme changes live. |
| `pdfPhoenix.pageColors` | `original` | Recolor pages to the editor's colors: `original`, `match-dark-themes`, or `match-all-themes`. See [Dark themes](#dark-themes). |
| `pdfPhoenix.annotations.highlightColor` | `yellow` | Color the highlight tool starts with: `yellow`, `green`, `blue`, `pink`, or `red`. |
| `pdfPhoenix.annotations.inkColor` | `#000000` | Color the draw tool starts with, as a hex color. |
| `pdfPhoenix.annotations.inkThickness` | `1` | Line thickness the draw tool starts with, from 1 to 20. |
| `pdfPhoenix.annotations.textColor` | `#000000` | Text color the text tool starts with, as a hex color. |
| `pdfPhoenix.annotations.textSize` | `10` | Font size the text tool starts with, from 5 to 100. |
| `pdfPhoenix.pdfjs.autoCheckForUpdates` | `true` | Check about once a day for a newer pdf.js within the current major version and ask before downloading. Major-version upgrades are never automatic. User setting only: a folder's workspace settings can't turn it off. |
| `pdfPhoenix.pdfjs.keepDownloadedVersion` | `false` | Keep using a downloaded or chosen pdf.js even after a PDF Phoenix update brings a built-in version that is the same or newer. When off, the newer built-in version takes over. User setting only. |

The theme settings apply to open PDFs right away. The others apply to PDFs you open after changing them.

## Requirements

VS Code `1.123.0` or newer. The bundled pdf.js uses browser features (such as `Uint8Array.prototype.toHex`) that first shipped in the Chromium inside that release; this minimum was found by running the extension's test suite against successive VS Code releases.

---

## Building from source

The bundled pdf.js viewer is downloaded from Mozilla's releases at build time (it isn't published on npm). The fetch step reuses the extension's own compiled code, so it compiles first: it checks the download against the SHA-256 digest GitHub publishes for it, extracts it, and validates, prunes and patches it exactly as the extension does for versions downloaded at runtime.

```bash
npm install
npm run fetch-assets   # compiles, then downloads and verifies Mozilla's prebuilt pdf.js viewer into media/pdfjs/
```

Press `F5` to launch an Extension Development Host, then open a `.pdf`. Use `npm run compile` (or `npm run watch`) after changing the TypeScript sources.

### Testing

```bash
npm test                    # unit tests, then the integration tests
npm run test:unit           # fast unit tests in Node (version logic, unzip, download checks, Markdown and XFDF export)
npm run test:integration    # integration tests in a real, downloaded VS Code
```

The integration tests download the latest stable VS Code into `.vscode-test/` and run the extension in it against generated PDFs, in three scenarios: a trusted workspace, Restricted Mode, and a non-English display language. Run a single scenario with `npm run test:integration -- restricted`, only matching tests with `PDFPHOENIX_TEST_GREP="Export"`, against a specific VS Code release with `PDFPHOENIX_VSCODE_VERSION=1.130.0`, or alongside a set of other installed extensions with `PDFPHOENIX_TEST_EXTENSIONS_DIR=<folder>` (point it at a copy of an extensions folder, since VS Code may update files in it). On Linux without a display, prefix the command with `xvfb-run -a`, as CI does.

### Packaging

```bash
npm run package        # produces pdf-phoenix-<version>.vsix
```

Install it with `code --install-extension pdf-phoenix-<version>.vsix`.

### Updating the bundled pdf.js version

Bump `VERSION` in `scripts/fetch-pdfjs.mjs` and re-run `npm run fetch-assets` (it replaces `media/pdfjs/` when the version differs). Then run the test suite, including against the oldest supported VS Code (`PDFPHOENIX_VSCODE_VERSION=1.123.0 npm run test:integration`), since a newer pdf.js may need a newer Chromium and therefore a higher minimum VS Code version.

### Note for WSL-mounted checkouts

If this project lives on a WSL drive accessed from Windows (a `\\wsl.localhost\...` path), run `npm install`, `code --install-extension`, and similar commands from a shell whose current directory is a native path (inside WSL, or a Windows-native directory), not the UNC path. Some of these tools spawn `cmd.exe`, which fails on a UNC working directory and can silently no-op (for example, `code --install-extension` reports nothing and the extension simply doesn't appear).

## Credits

Built on [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0). PDF Phoenix itself is MIT-licensed. See the `LICENSE` file.
