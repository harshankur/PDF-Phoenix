# Changelog

## 1.0.1

- Add an extension icon.

## 1.0.0

- View `.pdf` files in VS Code using Mozilla's full pdf.js viewer (bundled v6.1.200): toolbar, page navigation, text search, thumbnails and document outline, zoom, rotate, and print.
- Annotate PDFs (highlight, text, draw, images/stamps) and save the changes back into the file with `Ctrl/Cmd+S`, with an unsaved-changes indicator and revert support.
- Self-updating pdf.js engine: automatic same-major update checks (opt-out via `pdfPhoenix.pdfjs.autoCheckForUpdates`), plus commands to check now, choose any version, or return to the built-in version. A tested version is always bundled as a fallback.
- `Ctrl/Cmd+P` and `Ctrl/Cmd+Shift+P` are left to VS Code (Quick Open and the Command Palette) instead of being captured by pdf.js for printing; printing remains available from the viewer toolbar.
- Configurable opening view via `pdfPhoenix.defaultZoom` (default Page Fit) and `pdfPhoenix.defaultSidebar` (default document outline).
