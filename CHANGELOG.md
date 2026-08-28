# Changelog

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
