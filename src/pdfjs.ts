import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// The version marker written into every pdf.js copy (bundled + downloaded) so
// the two can be compared. No leading dot, to avoid any dotfile filtering when
// the bundled copy is packaged into the .vsix.
export const META_FILENAME = "pdf-phoenix-meta.json";

// Dev-only cruft shipped in Mozilla's dist zip that we don't want taking up
// space in the bundled/downloaded copy.
// scripts/fetch-pdfjs.mjs runs this same code to prepare the bundled copy.
export const PRUNE_PATHS = [
  path.join("web", "compressed.tracemonkey-pldi-09.pdf"),
  path.join("web", "debugger.mjs"),
  path.join("web", "debugger.mjs.map"),
  path.join("web", "debugger.css"),
];

// Source edits applied to the extracted viewer.
// scripts/fetch-pdfjs.mjs runs this same code to prepare the bundled copy.
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

// The exact strings in pdf.js's web/viewer.html that PDF Phoenix rewrites to
// load the viewer in a webview (see buildHtml in extension.ts). A pdf.js
// whose viewer.html lacks any of them can't be wired up: PDF Phoenix's script
// would never load and the editor would stay blank, with nothing to report
// why. So preparePdfjsDir rejects such a copy, and buildHtml refuses to
// continue past a missing one.
export const VIEWER_HTML_ANCHORS = {
  locale: 'href="locale/locale.json"',
  pdfMjs: 'src="../build/pdf.mjs"',
  viewerCss: 'href="viewer.css"',
  viewerMjs: '<script src="viewer.mjs" type="module"></script>',
} as const;

// Replace the first occurrence of anchor, or throw if viewer.html lacks it.
// Spliced rather than String.replace, whose replacement string would treat
// "$&", "$1" and the like as patterns.
export function replaceAnchor(html: string, anchor: string, replacement: string): string {
  const at = html.indexOf(anchor);
  if (at === -1) {
    throw new Error(`this pdf.js's viewer.html has no ${anchor}, which PDF Phoenix needs to load it`);
  }
  return html.slice(0, at) + replacement + html.slice(at + anchor.length);
}

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

  const viewerHtml = await fs.readFile(path.join(dir, "web", "viewer.html"), "utf8");
  for (const anchor of Object.values(VIEWER_HTML_ANCHORS)) {
    if (!viewerHtml.includes(anchor)) {
      throw new Error(`pdf.js validation failed: web/viewer.html no longer contains ${anchor}`);
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

export interface Release {
  version: string;
  prerelease: boolean;
}

// Whether a downloaded pdf.js should give way to the built-in one: once an
// extension update ships a built-in copy at least as new, it does, unless the
// user chose to keep the downloaded version (pdfPhoenix.pdfjs.keepDownloadedVersion).
export function builtInSupersedes(downloaded: string | null, builtIn: string | null, keepDownloaded: boolean): boolean {
  if (keepDownloaded || !downloaded || !builtIn || !parseVersion(downloaded) || !parseVersion(builtIn)) {
    return false;
  }
  return compareVersions(downloaded, builtIn) <= 0;
}

// The release an automatic or "check now" update should offer: the newest
// stable release in the active version's major line that is newer than the
// active version, or null when there is none. Never crosses a major version,
// since a major release could change internals that annotation saving and
// the shortcut patch rely on.
export function pickUpdate(releases: Release[], activeVersion: string): string | null {
  const major = parseVersion(activeVersion)?.[0];
  if (major === undefined) {
    return null;
  }
  const candidates = releases
    .filter((r) => !r.prerelease && parseVersion(r.version)?.[0] === major)
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = candidates[0]?.version;
  if (!latest || compareVersions(latest, activeVersion) <= 0) {
    return null;
  }
  return latest;
}

// A downloadable file attached to a GitHub release, with the size and the
// SHA-256 digest ("sha256:<hex>") GitHub publishes for it. GitHub only has
// digests for assets uploaded from mid-2025 on, so older releases lack one.
export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  digest?: string;
}

// The prebuilt viewer zip in each pdf.js release.
export function distAssetName(version: string): string {
  return `pdfjs-${version}-dist.zip`;
}

// Pick the viewer zip out of a release from GitHub's releases API.
export function findDistAsset(release: unknown, version: string): ReleaseAsset | undefined {
  const assets = (release as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) {
    return undefined;
  }
  const raw = assets.find((a) => a && a.name === distAssetName(version));
  if (!raw || typeof raw.browser_download_url !== "string" || typeof raw.size !== "number") {
    return undefined;
  }
  return {
    name: raw.name,
    url: raw.browser_download_url,
    size: raw.size,
    digest: typeof raw.digest === "string" ? raw.digest : undefined,
  };
}

// Check a downloaded zip against the release's published size and digest.
// Throws on any mismatch; otherwise says how thoroughly it was checked.
export function checkDownload(zip: Buffer, asset: ReleaseAsset): "verified" | "size-only" {
  if (zip.length !== asset.size) {
    throw new Error(`download is ${zip.length} bytes but GitHub lists ${asset.name} as ${asset.size}`);
  }
  if (!asset.digest) {
    return "size-only";
  }
  const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  if (!match) {
    throw new Error(`unrecognized digest format for ${asset.name}: ${asset.digest}`);
  }
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== match[1].toLowerCase()) {
    throw new Error(`${asset.name} doesn't match the SHA-256 digest GitHub publishes for it`);
  }
  return "verified";
}

// The warning to show before switching to a pdf.js from a different major
// version than the built-in one PDF Phoenix is tested with, or null when it's
// the same major version (or either version is unknown).
export function majorChangeWarning(picked: string, tested: string): string | null {
  const pickedMajor = parseVersion(picked)?.[0];
  const testedMajor = parseVersion(tested)?.[0];
  if (pickedMajor === undefined || testedMajor === undefined || pickedMajor === testedMajor) {
    return null;
  }
  const relation = pickedMajor > testedMajor ? "a newer" : "an older";
  return (
    `pdf.js ${picked} is ${relation} major release (${pickedMajor}.x) than the one PDF Phoenix is tested with ` +
    `(${testedMajor}.x). Annotation saving, the unsaved-changes indicator, or the print-key handling may not work ` +
    `correctly with it. Use it anyway?`
  );
}
