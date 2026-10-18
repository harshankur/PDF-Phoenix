// Downloads Mozilla's prebuilt pdf.js viewer (not published on npm) into
// media/pdfjs/, giving us the exact build/+web/ layout that viewer.html's
// relative asset paths expect.
//
// It goes through the same code the extension uses for pdf.js versions
// downloaded at runtime (compiled into out/, so run `tsc` first; the
// fetch-assets script does): the zip is checked against the SHA-256 digest
// GitHub publishes for the release, extracted with the extension's own
// unzipper, then validated, pruned and patched by preparePdfjsDir.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { checkDownload, findDistAsset, preparePdfjsDir, readMetaVersion, writeMeta } = require("../out/pdfjs.js");
const { unzipToDir } = require("../out/unzip.js");

const VERSION = "6.4.299";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, "..", "media", "pdfjs");
const viewerMarker = path.join(mediaDir, "web", "viewer.html");

// GitHub's API allows few unauthenticated requests per hour, and CI runners
// share addresses; use a token when one is provided.
function githubHeaders() {
  const headers = { "User-Agent": "PDF-Phoenix-build", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function main() {
  if (!existsSync(viewerMarker) || (await readMetaVersion(mediaDir)) !== VERSION) {
    // Wipe rather than extract-over: bumping VERSION locally without
    // deleting media/pdfjs/ first would otherwise leave the old release's
    // files mixed in and still label the directory with the new version.
    await rm(mediaDir, { recursive: true, force: true });
    await mkdir(mediaDir, { recursive: true });

    const releaseUrl = `https://api.github.com/repos/mozilla/pdf.js/releases/tags/v${VERSION}`;
    const releaseRes = await fetch(releaseUrl, { headers: githubHeaders() });
    if (!releaseRes.ok) {
      throw new Error(`Failed to read ${releaseUrl}: HTTP ${releaseRes.status}`);
    }
    const asset = findDistAsset(await releaseRes.json(), VERSION);
    if (!asset) {
      throw new Error(`pdf.js v${VERSION} has no viewer zip attached to its release.`);
    }

    console.log(`Downloading ${asset.url} ...`);
    const zipRes = await fetch(asset.url, { redirect: "follow" });
    if (!zipRes.ok) {
      throw new Error(`Failed to download ${asset.url}: HTTP ${zipRes.status}`);
    }
    const zip = Buffer.from(await zipRes.arrayBuffer());

    // The bundled copy ships to every user, so it must match Mozilla's
    // published digest exactly; a size check alone isn't enough here.
    if (checkDownload(zip, asset) !== "verified") {
      throw new Error(`GitHub publishes no SHA-256 digest for ${asset.name}; refusing to bundle it unverified.`);
    }
    console.log(`Verified ${asset.name} against ${asset.digest}`);

    console.log(`Extracting into ${mediaDir} ...`);
    await unzipToDir(zip, mediaDir);
  } else {
    console.log(`pdf.js ${VERSION} viewer already present at ${mediaDir}, skipping download.`);
  }

  // Idempotent: validates the layout, prunes dev-only files and applies the
  // print-shortcut patch (or confirms it's already applied).
  await preparePdfjsDir(mediaDir);
  await writeMeta(mediaDir, VERSION);
  console.log(`pdf.js ${VERSION} viewer ready at ${mediaDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
