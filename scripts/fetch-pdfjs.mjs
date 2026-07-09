// Downloads Mozilla's prebuilt pdf.js viewer (not published on npm) and
// extracts it into media/pdfjs/, giving us the exact build/+web/ layout
// that viewer.html's relative asset paths expect.
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";

const VERSION = "6.1.200";
const ZIP_NAME = `pdfjs-${VERSION}-dist.zip`;
const DOWNLOAD_URL = `https://github.com/mozilla/pdf.js/releases/download/v${VERSION}/${ZIP_NAME}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, "..", "media", "pdfjs");
const viewerMarker = path.join(mediaDir, "web", "viewer.html");

// Ships in Mozilla's release zip but is dev-only cruft we don't want
// bloating the packaged extension: the demo PDF and the pdf.js debugger.
const PRUNE_PATHS = [
  path.join("web", "compressed.tracemonkey-pldi-09.pdf"),
  path.join("web", "debugger.mjs"),
  path.join("web", "debugger.mjs.map"),
  path.join("web", "debugger.css"),
];

// pdf.js installs a global keydown handler that calls window.print() on
// Ctrl/Cmd+P, and, because window.chrome/window.opera is truthy in
// VS Code's Chromium webview, also on Ctrl/Cmd+Shift+P. That swallows
// VS Code's Quick Open and Command Palette shortcuts and shows pdf.js's
// "Preparing to print" overlay instead. Force the condition to false so
// pdf.js never captures those keys; printing stays available from the
// viewer toolbar. The unique trailing comment doubles as the "already
// patched" marker (a bare "false" appears all over the file).
// NOTE: keep PRUNE_PATHS/PATCHES in sync with src/pdfjs.ts, which applies
// the identical preparation to copies downloaded at runtime.
const PATCHES = [
  {
    file: path.join("web", "viewer.mjs"),
    from: '(!event.shiftKey || window.chrome || window.opera)',
    to: 'false /* pdf-phoenix: leave Ctrl/Cmd+P and Ctrl/Cmd+Shift+P to VS Code */',
  },
];

// Version marker so the runtime updater can compare the bundled fallback
// against downloaded copies. Keep the filename in sync with META_FILENAME
// in src/pdfjs.ts.
const META_FILENAME = "pdf-phoenix-meta.json";

async function main() {
  if (!existsSync(viewerMarker)) {
    await mkdir(mediaDir, { recursive: true });

    const tmpDir = mktempSafe();
    const zipPath = path.join(tmpDir, ZIP_NAME);

    console.log(`Downloading ${DOWNLOAD_URL} ...`);
    const response = await fetch(DOWNLOAD_URL, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${DOWNLOAD_URL}: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(zipPath));

    console.log(`Extracting into ${mediaDir} ...`);
    await extract(zipPath, { dir: mediaDir });

    rmSync(tmpDir, { recursive: true, force: true });

    for (const relPath of PRUNE_PATHS) {
      await rm(path.join(mediaDir, relPath), { force: true });
    }

    if (!existsSync(viewerMarker)) {
      throw new Error(
        `Extraction finished but ${viewerMarker} is missing. The pdf.js release layout may have changed.`
      );
    }
  } else {
    console.log(`pdf.js viewer already present at ${mediaDir}, skipping download.`);
  }

  for (const { file, from, to } of PATCHES) {
    const filePath = path.join(mediaDir, file);
    const content = await readFile(filePath, "utf8");
    if (content.includes(from)) {
      await writeFile(filePath, content.replace(from, to), "utf8");
      console.log(`Patched ${file}`);
    } else if (!content.includes(to)) {
      throw new Error(
        `Expected to find pattern in ${file} to patch (or evidence it was already patched), found neither. The pdf.js source may have changed.`
      );
    }
  }

  await writeFile(
    path.join(mediaDir, META_FILENAME),
    JSON.stringify({ version: VERSION }),
    "utf8"
  );

  console.log(`pdf.js ${VERSION} viewer ready at ${mediaDir}`);
}

function mktempSafe() {
  return mkdtempSync(path.join(tmpdir(), "pdf-phoenix-pdfjs-"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
