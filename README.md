# PDF Phoenix

View **and annotate** PDF files right inside VS Code, and actually save your annotations back into the file. Powered by Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), with a viewer engine that keeps itself up to date — so you're relying on pdf.js's own security track record, not on how often this extension gets updated.

Open any `.pdf` and it renders in pdf.js's full viewer: toolbar, page navigation, text search, thumbnails and document outline, zoom, rotate, and print.

## Security: pdf.js updates itself, independently of this extension

Most VS Code PDF extensions bundle a fixed pdf.js build. When Mozilla ships a security fix, you're stuck waiting on that extension's author to notice, bump the dependency, and publish a new release — which can take weeks, or never happen.

PDF Phoenix's pdf.js engine doesn't wait on that. About once a day it checks Mozilla's releases on its own and offers to update within the current major version; you can also jump to any specific release, or roll back, from the Command Palette at any time. That means you're relying on the security track record of pdf.js itself — one of the most widely used, heavily scrutinized PDF renderers in the world — not on how often PDF Phoenix happens to get republished. Full details in [Keeping the PDF engine up to date](#keeping-the-pdf-engine-up-to-date).

## Why PDF Phoenix

Most PDF extensions for VS Code are view-only wrappers around a fixed pdf.js build. PDF Phoenix adds the things they don't:

- **Annotations that save.** Highlight text, add text notes, draw, and add images or stamps, then press `Ctrl/Cmd+S` and the changes are written straight back into the PDF file. The editor tab shows the usual unsaved-changes dot, and `File: Revert File` discards edits. (This is real saving into the document, not a separate sidecar file.)
- **Your VS Code shortcuts stay yours.** pdf.js normally grabs `Ctrl/Cmd+P` and `Ctrl/Cmd+Shift+P` to print, popping a "Preparing to print" overlay over Quick Open and the Command Palette. PDF Phoenix stops that, so both shortcuts behave exactly as they do everywhere else in VS Code. Printing is still one click away on the viewer toolbar.
- **Opens the way you want.** Out of the box, a document opens at Page Fit zoom with the outline (bookmarks) sidebar showing, instead of leaving you to zoom and open panels first. Both are configurable (see [Settings](#settings)).

## Opening a PDF

Just open any `.pdf` file. PDF Phoenix is the default editor for PDFs, so a normal click in the Explorer opens it in the viewer. To switch back and forth with another editor, use **View: Reopen Editor With...**

## Editing and saving annotations

1. Pick a tool from the viewer toolbar: highlight, text, draw, or image/stamp.
2. Make your marks. The editor tab shows a dot to indicate unsaved changes.
3. Save with `Ctrl/Cmd+S`. The annotations are written into the PDF.

Undo and redo work inside the viewer with `Ctrl/Cmd+Z` and `Ctrl/Cmd+Y`. To throw away all unsaved edits, run **File: Revert File**.

> The unsaved-changes dot clears when you save or revert. Undoing edits inside the viewer reverts the content, but the dot stays until you save or revert, so you never lose track of whether what's on disk matches what you see.

## Keeping the PDF engine up to date

PDF Phoenix always ships with a bundled, tested version of pdf.js. On top of that, it can use a newer one you download at runtime — so a pdf.js security fix reaches you as soon as Mozilla ships it, not whenever PDF Phoenix next gets published:

- **Automatic checks.** About once a day, PDF Phoenix checks Mozilla's releases for a newer version *within the same major version* and asks before downloading. It never jumps to a new major version on its own, because a major release could change internals that annotation-saving and the shortcut handling rely on. Turn this off with the `pdfPhoenix.pdfjs.autoCheckForUpdates` setting.
- **Commands** (open the Command Palette and type "PDF Phoenix"):
  - **PDF Phoenix: Check for pdf.js Updates** checks now for the latest release in the current major version.
  - **PDF Phoenix: Choose pdf.js Version...** lets you pick any release from Mozilla's history, or return to the built-in version. Choosing a different major version asks for confirmation first.
  - **PDF Phoenix: Use Built-in pdf.js Version** goes back to the version that shipped with the extension.

Downloaded versions are stored per-user and survive extension updates. A downloaded copy is only used if it passes validation; anything that fails to download or verify leaves your current engine untouched. Switching versions applies to PDFs you open afterward. Already-open tabs keep their current engine until you close and reopen them.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pdfPhoenix.defaultZoom` | `page-fit` | Zoom a PDF opens at: `auto`, `page-fit`, `page-width`, or `page-actual`. |
| `pdfPhoenix.defaultSidebar` | `outline` | Sidebar panel a PDF opens with: `none`, `thumbnails`, or `outline`. (Outline falls back to thumbnails when a PDF has no bookmarks.) |
| `pdfPhoenix.pdfjs.autoCheckForUpdates` | `true` | Check about once a day for a newer pdf.js within the current major version and ask before downloading. Major-version upgrades are never automatic. |

Zoom and sidebar changes take effect on PDFs you open after changing them.

## Requirements

VS Code `1.48.0` or newer (the Custom Editor API this extension relies on stabilized in `1.46`; `1.48` is used as a small safety margin).

---

## Building from source

The bundled pdf.js viewer is downloaded from Mozilla's releases at build time (it isn't published on npm), so a fetch step runs before compilation.

```bash
npm install
npm run fetch-assets   # downloads Mozilla's prebuilt pdf.js viewer into media/pdfjs/
npm run compile
```

Press `F5` to launch an Extension Development Host, then open a `.pdf`.

### Packaging

```bash
npm run package        # produces pdf-phoenix-<version>.vsix
```

Install it with `code --install-extension pdf-phoenix-<version>.vsix`.

### Updating the bundled pdf.js version

Bump `VERSION` in `scripts/fetch-pdfjs.mjs`, delete `media/pdfjs/`, and re-run `npm run fetch-assets`. Keep the `PRUNE_PATHS`/`PATCHES` constants there in sync with `src/pdfjs.ts`, which applies the identical preparation to versions downloaded at runtime.

### Note for WSL-mounted checkouts

If this project lives on a WSL drive accessed from Windows (a `\\wsl.localhost\...` path), run `npm install`, `code --install-extension`, and similar commands from a shell whose current directory is a native path (inside WSL, or a Windows-native directory), not the UNC path. Some of these tools spawn `cmd.exe`, which fails on a UNC working directory and can silently no-op (for example, `code --install-extension` reports nothing and the extension simply doesn't appear).

## Credits

Built on [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0). PDF Phoenix itself is MIT-licensed. See the `LICENSE` file.
