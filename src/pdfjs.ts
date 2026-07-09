import * as fs from "node:fs/promises";
import * as path from "node:path";

// The version marker written into every pdf.js copy (bundled + downloaded) so
// the two can be compared. No leading dot, to avoid any dotfile filtering when
// the bundled copy is packaged into the .vsix.
export const META_FILENAME = "pdf-phoenix-meta.json";

// Dev-only cruft shipped in Mozilla's dist zip that we don't want taking up
// space in the bundled/downloaded copy.
// NOTE: keep in sync with scripts/fetch-pdfjs.mjs (which preps the bundled copy).
export const PRUNE_PATHS = [
  path.join("web", "compressed.tracemonkey-pldi-09.pdf"),
  path.join("web", "debugger.mjs"),
  path.join("web", "debugger.mjs.map"),
  path.join("web", "debugger.css"),
];

// Source edits applied to the extracted viewer.
// NOTE: keep in sync with scripts/fetch-pdfjs.mjs.
export const PATCHES = [
  {
    // pdf.js installs a global keydown handler that calls window.print() on
    // Ctrl/Cmd+P, and, when window.chrome/opera is truthy (which it is in
    // VS Code's Chromium webview), also on Ctrl/Cmd+Shift+P. That swallows
    // VS Code's Quick Open and Command Palette shortcuts and pops pdf.js's
    // "Preparing to print" overlay instead. Force the condition to false so
    // pdf.js never captures those keys; printing stays available from the
    // viewer toolbar. The unique trailing comment is also the "already
    // patched" marker (a bare "false" appears all over the file).
    file: path.join("web", "viewer.mjs"),
    from: "(!event.shiftKey || window.chrome || window.opera)",
    to: "false /* pdf-phoenix: leave Ctrl/Cmd+P and Ctrl/Cmd+Shift+P to VS Code */",
  },
];

const REQUIRED_FILES = [
  path.join("web", "viewer.html"),
  path.join("web", "viewer.mjs"),
  path.join("web", "viewer.css"),
  path.join("build", "pdf.mjs"),
  path.join("build", "pdf.worker.mjs"),
];

// Validate an extracted pdf.js dir, then prune and patch it in place. Throws if
// the layout is unrecognizable or a patch target is missing; the caller treats
// that as "reject this download, keep the current copy" rather than shipping a
// viewer where the Ctrl+Shift+P fix silently doesn't apply.
export async function preparePdfjsDir(dir: string): Promise<void> {
  for (const rel of REQUIRED_FILES) {
    let size = -1;
    try {
      size = (await fs.stat(path.join(dir, rel))).size;
    } catch {
      size = -1;
    }
    if (size <= 0) {
      throw new Error(`pdf.js validation failed: missing or empty ${rel}`);
    }
  }

  for (const rel of PRUNE_PATHS) {
    await fs.rm(path.join(dir, rel), { force: true });
  }

  for (const { file, from, to } of PATCHES) {
    const full = path.join(dir, file);
    const content = await fs.readFile(full, "utf8");
    if (content.includes(from)) {
      await fs.writeFile(full, content.split(from).join(to), "utf8");
    } else if (!content.includes(to)) {
      throw new Error(`pdf.js validation failed: patch target not found in ${file}`);
    }
  }
}

export async function readMetaVersion(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, META_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function writeMeta(dir: string, version: string): Promise<void> {
  await fs.writeFile(path.join(dir, META_FILENAME), JSON.stringify({ version }), "utf8");
}

export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Negative if a < b, positive if a > b, 0 if equal or unparseable.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}
