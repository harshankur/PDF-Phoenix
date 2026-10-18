# Changelog

## 1.1.1

### Fixes

- **The built-in pdf.js now takes over after an update.** A pdf.js you downloaded earlier stayed in use even when a PDF Phoenix update brought a newer built-in version (for example, 6.3.289 downloaded under 1.0.x stayed active after 1.1.0 shipped 6.4.299). Now a download that is the same as or older than the built-in version gives way to it, and its folder is removed.
- Choosing the built-in version's own number from **Choose pdf.js Version...** or an update check now switches to the built-in copy instead of downloading a duplicate.
- Two cleanups of old pdf.js folders running at once could clash and forget a folder that was due for removal.

### New

- **`pdfPhoenix.pdfjs.keepDownloadedVersion`** (off by default) keeps the pdf.js version you downloaded or chose even after an update brings a newer built-in one, for anyone who needs to stay on a specific version.

## 1.1.0

### New

- **Bundled pdf.js updated to 6.4.299** (from 6.1.200), the latest Mozilla release.
- **Theme-matched viewing.** The viewer's toolbar, sidebar, and dialogs follow VS Code's light or dark theme, switching live. Pin one with `pdfPhoenix.viewerTheme` (`match-vscode`, `light`, `dark`). The new `pdfPhoenix.pageColors` setting can also recolor page content to the editor's background and text colors, in dark themes only (`match-dark-themes`) or always (`match-all-themes`); off by default, and display only, so saved annotation colors are unaffected.
- **Picks up where you left off.** Reopening a PDF restores its page, zoom, scroll position, rotation, sidebar panel, and scroll/spread mode, remembered per workspace for the 200 most recently viewed PDFs. Turn off with `pdfPhoenix.rememberViewState`.
- **Export Annotations to Markdown.** A new command (Command Palette, the PDF editor's `...` menu, or right-clicking a PDF in the Explorer) lists every highlight, note, text box, drawing, stamp and shape by page, with highlighted text quoted and colors, authors and dates, including annotations not saved yet. It opens as an untitled Markdown document.
- **XFDF export and import.** **Export Annotations as XFDF…** writes a PDF's annotations in the standard exchange format Acrobat and other PDF tools use, keeping positions, shapes, colors, notes, authors and dates. **Import Annotations from XFDF…** adds the highlights, drawings and text boxes (with their notes) from an XFDF file to the open PDF as unsaved, undoable edits, asks first if the file was made for a different PDF, and reports any annotation types it couldn't create.
- **Annotation tool defaults.** `pdfPhoenix.annotations.highlightColor`, `inkColor`, `inkThickness`, `textColor` and `textSize` set the colors and sizes the highlight, draw and text tools start with.
- **More opening defaults.** `pdfPhoenix.defaultScrollMode`, `defaultSpreadMode` (two-page spreads) and `defaultCursorTool` (text selection or hand tool). Scroll and spread default to whatever layout the PDF itself asks for.
- **Display language.** The viewer's toolbar and menus now follow VS Code's display language rather than the system's.
- **Restricted Mode.** PDF Phoenix now works in untrusted folders instead of being disabled there (which made PDFs open as raw text). JavaScript embedded in PDFs does not run in Restricted Mode; trusting the folder turns it on.
- **Engine switches apply to open PDFs.** Changing the pdf.js version now rebuilds open PDFs right away, in every VS Code window (or after the next save or revert, if they have unsaved changes), instead of only affecting PDFs opened afterwards. Each downloaded version gets its own folder, and a replaced one is only removed once nothing uses it, so a PDF still open on the previous version never loses the fonts or image decoders it loads from there.
- **No more blank editors.** If pdf.js can't start or can't open a document, PDF Phoenix says why. When a downloaded pdf.js is the cause, it offers to switch back to the built-in one.

### Security

- Downloaded pdf.js releases are now checked against the size and SHA-256 digest GitHub publishes for them before anything is extracted. Releases without a published digest (before mid-2025) are installed only after you confirm a size-only check; if the release details can't be fetched, nothing is installed. The bundled copy is verified the same way at build time, and the build now reuses the extension's own unzip and preparation code instead of the `extract-zip` package (which has an unfixed advisory).
- The pdf.js unzipper rejects absolute entry paths, truncated or ZIP64 archives, and entries that expand past their declared size.
- `pdfPhoenix.pdfjs.autoCheckForUpdates` is now a user-level setting, so a folder's workspace settings can no longer switch off update checks for the pdf.js engine shared across all of VS Code.

### Performance

- pdf.js now actually parses PDFs in its Web Worker. Its worker had never been able to start inside the webview, so every PDF was parsed on the viewer's own thread, freezing the UI on large documents.
- PDFs now cross between VS Code and the viewer as binary data rather than base64 text. On a 40 MB PDF: open 763 ms to 274 ms, save 493 ms to 131 ms, revert 497 ms to 205 ms.

### Fixes

- **Unsaved annotations are no longer lost after a restart or crash.** VS Code's hot exit backs up a PDF with unsaved changes, but on restoring it PDF Phoenix showed the file from disk instead of the backup, under the unsaved-changes dot; saving then overwrote the annotations for good. Restored PDFs now show exactly what was backed up.

- Reloads that should happen (a PDF changed on disk, or a theme change calling for different page colors) silently didn't: VS Code ignores re-assigning a webview the same HTML.
- A PDF that changed on disk while it had unsaved annotations was reloaded, silently discarding them. Unsaved annotations are now kept, with a notification offering to reload from disk.
- pdf.js's own hidden view history (keyed by file contents) could open a PDF at a page from an identical copy elsewhere. Opening is now driven only by PDF Phoenix's settings and its own per-file memory.
- **PDF Phoenix: Use Built-in pdf.js Version** no longer stays "running" until its confirmation is dismissed.
- A save or hot-exit backup no longer waits out a 10-second timeout when the PDF's viewer has just closed; it fails immediately, so VS Code can move on. Likewise, an export or import running when its viewer reloads fails at once instead of after two minutes.
- An edit made in the moment before a PDF changed on disk (or before a theme, trust or engine change reloaded it) could be lost to the reload; the viewer is now asked for any such edit first.
- Saving a large PDF to a slow or network drive could mistake its own write for a change made elsewhere and reload the viewer.
- A PDF whose own scripts fill in form fields when it opens no longer shows as having unsaved changes straight away.
- A downloaded pdf.js whose `viewer.html` PDF Phoenix can't hook into is rejected at install, and if one is ever found when opening a PDF, the editor says so (offering the built-in pdf.js) instead of staying blank.

### Changed

- **Minimum VS Code version is now 1.123.0.** The previously declared minimum (`1.49`) was never accurate: the bundled pdf.js 6 needs browser features (such as `Uint8Array.prototype.toHex`) that first shipped in the Chromium inside VS Code 1.123.0, and on older versions the viewer stayed blank. The new minimum comes from running the test suite against successive VS Code releases.

### Development

- Added a test suite: unit tests for the version, download-verification, unzip, Markdown and XFDF logic, and integration tests that run the extension in a real, downloaded VS Code (trusted workspace, Restricted Mode, and a non-English display language). CI runs both.

## 1.0.3

- Fix: PDFs failed to render on any downloaded pdf.js engine (every version chosen through "Check for Updates" or "Choose Version…"), showing a blank editor. pdf.js's `viewer.html` ships its own Content-Security-Policy locked to `script-src 'self'` / `style-src 'self'`; inlined unchanged into a webview, that `'self'` matches the shell document's origin rather than the resource host serving the files, so every script and stylesheet was blocked. The bundled engine (served from the extension directory) happened to slip through, but a downloaded engine lives on a different resource host in global storage and was blocked outright. The policy is now rebuilt from `webview.cspSource` so scripts and styles load from either host.
- Fix: pdf.js's runtime side-assets (cMaps for CJK text, standard font data for non-embedded base-14 fonts, the WASM decoders for JPEG2000/JBIG2 images and ICC-based colour, and the scripting sandbox) resolved against the webview shell origin and 404'd whenever a PDF needed them. They are now pointed at the correct webview URIs, matching how `pdf.mjs`/`viewer.mjs`/`viewer.css` were already handled.
- Raise the declared minimum VS Code version from `1.48.0` to `1.49.0`, matching `Webview.cspSource` (added in `1.49`).

## 1.0.2

- Lower the declared minimum VS Code version from `1.90.0` to `1.48.0`, matching the actual API surface used (the Custom Editor API, stabilized in `1.46`) instead of an unverified scaffold default.
- Fix: a failed save could permanently disable file-change detection for that document, silently ignoring later external edits. Reworked as a self-clearing time window instead of a one-shot flag.
- Fix: reverting a document repeatedly leaked one edit-tracking timer per revert, left running for the life of the webview.
- Fix: saving or backing up a PDF in the brief window right before the viewer finished loading could throw inside the webview and stall for the full 10s timeout instead of failing fast; the webview now reports the error back immediately.
- Fix: starting a pdf.js version install while one was already running could interleave two versions' files into the same staging directory.
- Fix: a failed pdf.js install swap could leave no engine installed at all instead of preserving the previously installed version.
- Fix: pending save/backup requests are now cancelled immediately when their PDF tab is closed, instead of hanging until the timeout.
- Fix: `npm run fetch-assets` could silently keep a stale bundled pdf.js copy after bumping the version locally without clearing `media/pdfjs/` first.

## 1.0.1

- Add an extension icon.

## 1.0.0

- View `.pdf` files in VS Code using Mozilla's full pdf.js viewer (bundled v6.1.200): toolbar, page navigation, text search, thumbnails and document outline, zoom, rotate, and print.
- Annotate PDFs (highlight, text, draw, images/stamps) and save the changes back into the file with `Ctrl/Cmd+S`, with an unsaved-changes indicator and revert support.
- Self-updating pdf.js engine: automatic same-major update checks (opt-out via `pdfPhoenix.pdfjs.autoCheckForUpdates`), plus commands to check now, choose any version, or return to the built-in version. A tested version is always bundled as a fallback.
- `Ctrl/Cmd+P` and `Ctrl/Cmd+Shift+P` are left to VS Code (Quick Open and the Command Palette) instead of being captured by pdf.js for printing; printing remains available from the viewer toolbar.
- Configurable opening view via `pdfPhoenix.defaultZoom` (default Page Fit) and `pdfPhoenix.defaultSidebar` (default document outline).
