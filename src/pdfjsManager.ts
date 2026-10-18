import { watch as watchFs } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { unzipToDir } from "./unzip";
import {
  Release,
  ReleaseAsset,
  checkDownload,
  builtInSupersedes,
  compareVersions,
  findDistAsset,
  majorChangeWarning,
  parseVersion,
  pickUpdate,
  preparePdfjsDir,
  readMetaVersion,
  writeMeta,
} from "./pdfjs";

const RELEASES_API = "https://api.github.com/repos/mozilla/pdf.js/releases?per_page=100";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "pdfPhoenix.lastUpdateCheck";
const SKIPPED_VERSION_KEY = "pdfPhoenix.skippedVersion";

// Downloaded engines live in their own folders under global storage, one per
// install, and a pointer file names the active one. Switching engines only
// rewrites the pointer: a folder that open viewers still load assets from
// (fonts, cMaps, image decoders) is never touched while they need it.
const ENGINES_DIR = "engines";
const POINTER_FILE = "active-engine.json";
const RETIRED_FILE = "retired-engines.json";
// The 1.0.x layout: a single downloaded copy in "pdfjs".
const LEGACY_DIR = "pdfjs";
// How long a superseded engine folder is kept. Viewers in this window are
// tracked exactly; viewers in other VS Code windows (which share global
// storage) get the pointer change too and rebuild, except any with unsaved
// changes, which this leaves days to be saved or reverted.
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Owns everything about which pdf.js build is in effect: resolving between the
// bundled fallback and a downloaded copy, checking Mozilla's releases, and
// downloading/installing/resetting on request.
export class PdfjsManager {
  private readonly engineChanged = new vscode.EventEmitter<void>();
  // Fires after a different pdf.js has been installed or the built-in one
  // restored, so open viewers can be rebuilt on it.
  readonly onDidChangeEngine = this.engineChanged.event;

  private retentionMs = DEFAULT_RETENTION_MS;
  // Changes to the retired list run one at a time: a cleanup and a switch
  // overlapping would otherwise each write their own copy, losing an entry.
  private retiredQueue: Promise<unknown> = Promise.resolve();
  private lastActiveRoot: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get storageRoot(): string {
    return this.context.globalStorageUri.fsPath;
  }

  get storagePath(): string {
    return this.storageRoot;
  }

  private get bundledDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs");
  }

  // The downloaded engine the pointer names, if it's a usable one. No
  // pointer yet means the 1.0.x layout, if that copy exists.
  private async pointedDownload(): Promise<string | null> {
    let pointer: { dir?: unknown } | null = null;
    try {
      pointer = JSON.parse(await fs.readFile(path.join(this.storageRoot, POINTER_FILE), "utf8"));
    } catch {
      pointer = null;
    }
    const candidate =
      pointer === null
        ? path.join(this.storageRoot, LEGACY_DIR)
        : typeof pointer.dir === "string" && /^[\w.-]+$/.test(pointer.dir)
          ? path.join(this.storageRoot, ENGINES_DIR, pointer.dir)
          : null;
    return candidate && (await isValidEngine(candidate)) ? candidate : null;
  }

  // The folder of the active downloaded engine, or null for the built-in
  // one: also when an extension update brought a built-in copy at least as
  // new, unless pdfPhoenix.pdfjs.keepDownloadedVersion is on.
  private async activeDownloadDir(): Promise<string | null> {
    const pointed = await this.pointedDownload();
    if (!pointed) {
      return null;
    }
    const superseded = builtInSupersedes(
      await readMetaVersion(pointed),
      await readMetaVersion(this.bundledDir.fsPath),
      keepDownloadedVersion()
    );
    return superseded ? null : pointed;
  }

  // Point back at the built-in engine when it has superseded the download,
  // so the download's folder is retired and later removed.
  async retireSupersededDownload(): Promise<void> {
    if ((await this.pointedDownload()) && !(await this.activeDownloadDir())) {
      await this.activate(null);
    }
  }

  // pdfPhoenix.pdfjs.keepDownloadedVersion changed: open viewers move to the
  // engine now in effect, and turning it off retires a superseded download.
  async onKeepDownloadedVersionChanged(): Promise<void> {
    if (!keepDownloadedVersion()) {
      await this.retireSupersededDownload();
    }
    await this.noticeEngineChange();
  }

  // The pdf.js root the webview should load from: the active downloaded copy
  // when there is a valid one, otherwise the bundled fallback. A download's
  // URI is built from globalStorageUri, not Uri.file: global storage can use
  // its own scheme (vscode-userdata), and the webview only serves files under
  // the roots it was given (localResourceRoots), compared scheme and all.
  async activeRootUri(): Promise<vscode.Uri> {
    const dir = await this.activeDownloadDir();
    if (!dir) {
      return this.bundledDir;
    }
    const segments = path.relative(this.storageRoot, dir).split(path.sep);
    return vscode.Uri.joinPath(this.context.globalStorageUri, ...segments);
  }

  async activeInfo(): Promise<{ version: string | null; source: "downloaded" | "bundled" }> {
    const dir = await this.activeDownloadDir();
    if (dir) {
      return { version: await readMetaVersion(dir), source: "downloaded" };
    }
    return { version: await readMetaVersion(this.bundledDir.fsPath), source: "bundled" };
  }

  // Both roots must be reachable by the webview: bundled lives under the
  // extension dir, downloaded under global storage.
  localResourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.context.extensionUri, "media"), this.context.globalStorageUri];
  }

  // Follow engine switches made in other VS Code windows (which share global
  // storage) by watching the pointer file, so their open PDFs move to the new
  // engine too rather than keep loading from a folder that will be removed.
  async startWatching(): Promise<vscode.Disposable> {
    this.lastActiveRoot = (await this.activeRootUri()).fsPath;
    await fs.mkdir(this.storageRoot, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watchFs(this.storageRoot, (_event, file) => {
      if (file && String(file) !== POINTER_FILE) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void this.noticeEngineChange(), 200);
    });
    watcher.on("error", () => undefined);
    return new vscode.Disposable(() => {
      clearTimeout(timer);
      watcher.close();
    });
  }

  // Fire onDidChangeEngine if the active engine differs from the last one
  // seen, whoever changed it.
  private async noticeEngineChange(): Promise<void> {
    const root = (await this.activeRootUri()).fsPath;
    if (root !== this.lastActiveRoot) {
      this.lastActiveRoot = root;
      this.engineChanged.fire();
    }
  }

  private updateRetired<T>(change: () => Promise<T>): Promise<T> {
    const run = this.retiredQueue.then(change);
    this.retiredQueue = run.catch(() => undefined);
    return run;
  }

  private async readRetired(): Promise<Record<string, number>> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.storageRoot, RETIRED_FILE), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeJsonAtomically(file: string, value: unknown): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), "utf8");
    await fs.rename(temp, file);
  }

  // Point at a different engine (a folder under engines/, or null for the
  // built-in one), retiring the previously named download.
  private async activate(dirName: string | null): Promise<void> {
    await fs.mkdir(this.storageRoot, { recursive: true });
    const previous = await this.pointedDownload();
    await this.writeJsonAtomically(path.join(this.storageRoot, POINTER_FILE), { dir: dirName });
    if (previous) {
      await this.updateRetired(async () => {
        const retired = await this.readRetired();
        retired[path.relative(this.storageRoot, previous)] = Date.now();
        await this.writeJsonAtomically(path.join(this.storageRoot, RETIRED_FILE), retired);
      });
    }
    await this.noticeEngineChange();
  }

  // Delete retired engine folders no viewer in this window uses any more,
  // once they've been retired longer than the retention period, and any
  // install staging left behind by an interrupted install.
  async removeUnusedEngines(inUse: ReadonlySet<string>): Promise<void> {
    await this.updateRetired(async () => {
      const retired = await this.readRetired();
      let changed = false;
      for (const [relative, retiredAt] of Object.entries(retired)) {
        const dir = path.join(this.storageRoot, relative);
        if (!inUse.has(dir) && Date.now() - retiredAt >= this.retentionMs) {
          await fs.rm(dir, { recursive: true, force: true });
          delete retired[relative];
          changed = true;
        }
      }
      if (changed) {
        await this.writeJsonAtomically(path.join(this.storageRoot, RETIRED_FILE), retired);
      }
    });
    try {
      for (const entry of await fs.readdir(this.storageRoot)) {
        if (entry.startsWith("staging-") && !this.installing) {
          await fs.rm(path.join(this.storageRoot, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // No storage yet.
    }
  }

  // Test hooks (ExtensionMode.Test only, see extension.ts).
  setRetentionForTests(ms: number): void {
    this.retentionMs = ms;
  }

  // Install a copy of the bundled engine as if it had been downloaded, for
  // tests that can't reach GitHub; breakViewerHtml removes the script tag
  // PDF Phoenix hooks into, to check such an engine is rejected.
  async installBundledCopyForTests(version: string, options: { breakViewerHtml?: boolean } = {}): Promise<void> {
    this.installing = true;
    try {
      await this.installBundledCopy(version, options);
    } finally {
      this.installing = false;
    }
  }

  private async installBundledCopy(version: string, options: { breakViewerHtml?: boolean }): Promise<void> {
    const staging = path.join(this.storageRoot, `staging-test-${Date.now()}`);
    await fs.mkdir(this.storageRoot, { recursive: true });
    await fs.cp(this.bundledDir.fsPath, staging, { recursive: true });
    if (options.breakViewerHtml) {
      const viewer = path.join(staging, "web", "viewer.html");
      const html = await fs.readFile(viewer, "utf8");
      await fs.writeFile(viewer, html.replace('<script src="viewer.mjs" type="module"></script>', ""), "utf8");
    }
    await this.installPrepared(staging, version);
  }

  // ---------- networking ----------

  private async fetchReleases(): Promise<Release[]> {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": "PDF-Phoenix", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
    const data = (await res.json()) as Array<{ tag_name: string; prerelease: boolean }>;
    const releases: Release[] = [];
    for (const entry of data) {
      const parsed = parseVersion(entry.tag_name);
      if (parsed) {
        releases.push({ version: parsed.join("."), prerelease: !!entry.prerelease });
      }
    }
    return releases;
  }

  // The release's viewer zip, with the size and SHA-256 digest GitHub
  // publishes for it. Without these the download can't be verified, so
  // failing to get them stops the install.
  private async fetchDistAsset(version: string): Promise<ReleaseAsset> {
    const res = await fetch(`https://api.github.com/repos/mozilla/pdf.js/releases/tags/v${version}`, {
      headers: { "User-Agent": "PDF-Phoenix", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`could not get the details of v${version} from GitHub (${res.status}) to verify the download`);
    }
    const asset = findDistAsset(await res.json(), version);
    if (!asset) {
      throw new Error(`release v${version} has no viewer download`);
    }
    return asset;
  }

  private async downloadZip(asset: ReleaseAsset): Promise<Buffer> {
    const res = await fetch(asset.url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`download failed (${res.status}) for ${asset.name}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- install / reset ----------

  // Only one install at a time (e.g. a double command-palette invocation
  // racing the startup auto-check prompt), and while one runs, cleanup leaves
  // staging folders alone.
  private installing = false;

  // Download, verify and extract into a staging folder, then hand it to
  // installPrepared. The active engine isn't touched until the very end, so a
  // failed or invalid download leaves the current viewer intact.
  async install(version: string): Promise<void> {
    if (this.installing) {
      throw new Error("PDF Phoenix is already installing a pdf.js version. Try again once it finishes.");
    }
    this.installing = true;
    try {
      const asset = await this.fetchDistAsset(version);
      if (!asset.digest) {
        const proceed = await vscode.window.showWarningMessage(
          `GitHub doesn't publish a checksum for pdf.js ${version} (it only does for releases from mid-2025 on), ` +
            `so PDF Phoenix can only check the download's size, not that its contents are exactly what Mozilla released. Install it anyway?`,
          { modal: true },
          "Install Anyway"
        );
        if (proceed !== "Install Anyway") {
          throw new Error("installation cancelled.");
        }
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `PDF Phoenix: installing pdf.js v${version}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "downloading…" });
          const zip = await this.downloadZip(asset);

          // Before anything is extracted: the exact bytes Mozilla published.
          progress.report({ message: "verifying…" });
          checkDownload(zip, asset);

          progress.report({ message: "extracting…" });
          const staging = path.join(this.storageRoot, `staging-${Date.now()}`);
          await fs.mkdir(staging, { recursive: true });
          await unzipToDir(zip, staging);

          progress.report({ message: "validating…" });
          await this.installPrepared(staging, version);
        }
      );
    } finally {
      this.installing = false;
    }
  }

  // Validate, prune and patch an extracted engine in staging, move it into
  // its own folder and make it the active one. Anything that fails leaves
  // the current engine in place and removes the staging copy.
  private async installPrepared(staging: string, version: string): Promise<void> {
    try {
      await preparePdfjsDir(staging);
      await writeMeta(staging, version);
      const name = `v${version}-${Date.now()}`;
      await fs.mkdir(path.join(this.storageRoot, ENGINES_DIR), { recursive: true });
      await fs.rename(staging, path.join(this.storageRoot, ENGINES_DIR, name));
      await this.activate(name);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async resetToBundled(): Promise<void> {
    await this.activate(null);
  }

  private async installWithFeedback(version: string): Promise<void> {
    // The built-in copy is that exact version: use it rather than download
    // a duplicate.
    const bundledVersion = await readMetaVersion(this.bundledDir.fsPath);
    if (bundledVersion !== null && compareVersions(version, bundledVersion) === 0 && parseVersion(version)) {
      await this.resetToBundled();
      await vscode.window.showInformationMessage(
        `PDF Phoenix is now using pdf.js ${version}, the version built into it. ${OPEN_PDFS_SWITCH}`
      );
      return;
    }
    try {
      await this.install(version);
      await vscode.window.showInformationMessage(
        `PDF Phoenix is now using pdf.js ${version}. ${OPEN_PDFS_SWITCH}`
      );
    } catch (err) {
      await vscode.window.showErrorMessage(
        `PDF Phoenix could not switch to pdf.js ${version}: ${messageOf(err)} The previous version is still in use.`
      );
    }
  }

  // Newest stable release sharing the active copy's major version, or null if
  // already current. Auto-update never crosses a major on its own.
  private async latestSameMajor(): Promise<string | null> {
    const info = await this.activeInfo();
    return pickUpdate(await this.fetchReleases(), info.version ?? "0.0.0");
  }

  // ---------- policies / commands ----------

  // Throttled background check on activation: offer newer same-major releases.
  async maybeAutoCheck(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pdfPhoenix");
    if (!cfg.get<boolean>("pdfjs.autoCheckForUpdates", true)) {
      return;
    }
    const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
    const now = Date.now();
    if (now - last < CHECK_INTERVAL_MS) {
      return;
    }
    await this.context.globalState.update(LAST_CHECK_KEY, now);

    try {
      const latest = await this.latestSameMajor();
      if (!latest) {
        return;
      }
      if (this.context.globalState.get<string>(SKIPPED_VERSION_KEY) === latest) {
        return;
      }
      const current = (await this.activeInfo()).version ?? "unknown";
      const choice = await vscode.window.showInformationMessage(
        `A newer pdf.js is available: ${latest} (PDF Phoenix is using ${current}). Update the PDF engine?`,
        "Update",
        "Skip This Version",
        "Not Now"
      );
      if (choice === "Update") {
        await this.installWithFeedback(latest);
      } else if (choice === "Skip This Version") {
        await this.context.globalState.update(SKIPPED_VERSION_KEY, latest);
      }
    } catch (err) {
      // Background check: never interrupt on failure, just log.
      console.error("PDF Phoenix update check failed:", err);
    }
  }

  async commandCheckForUpdate(): Promise<void> {
    try {
      const latest = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "PDF Phoenix: checking for pdf.js updates…" },
        () => this.latestSameMajor()
      );
      if (!latest) {
        const info = await this.activeInfo();
        await vscode.window.showInformationMessage(
          `PDF Phoenix is already using the latest pdf.js (${info.version ?? "unknown"}).`
        );
        return;
      }
      const current = (await this.activeInfo()).version ?? "unknown";
      const choice = await vscode.window.showInformationMessage(
        `A newer pdf.js is available: ${latest} (PDF Phoenix is using ${current}). Update the PDF engine?`,
        "Update",
        "Not Now"
      );
      if (choice === "Update") {
        await this.installWithFeedback(latest);
      }
    } catch (err) {
      await vscode.window.showErrorMessage(`PDF Phoenix could not check for pdf.js updates: ${messageOf(err)}`);
    }
  }

  async commandSelectVersion(): Promise<void> {
    let releases: Release[];
    try {
      releases = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "PDF Phoenix: fetching pdf.js releases…" },
        () => this.fetchReleases()
      );
    } catch (err) {
      await vscode.window.showErrorMessage(`PDF Phoenix could not load the pdf.js release list: ${messageOf(err)}`);
      return;
    }
    releases.sort((a, b) => compareVersions(b.version, a.version));

    const info = await this.activeInfo();
    const bundledVersion = await readMetaVersion(this.bundledDir.fsPath);
    const latestStable = releases.find((r) => !r.prerelease)?.version;

    interface VersionItem extends vscode.QuickPickItem {
      version?: string;
      reset?: boolean;
    }

    const items: VersionItem[] = [
      {
        label: "$(discard) Use the built-in version",
        description: bundledVersion ? `${bundledVersion} (ships with PDF Phoenix)` : "ships with PDF Phoenix",
        reset: true,
      },
    ];
    for (const release of releases) {
      const tags = [
        info.version === release.version ? "in use" : "",
        release.version === latestStable ? "latest" : "",
        release.prerelease ? "prerelease" : "",
      ].filter(Boolean);
      items.push({
        label: release.version,
        description: tags.join(" · ") || undefined,
        version: release.version,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: "Choose the pdf.js version PDF Phoenix uses",
      placeHolder: `In use: ${info.version ?? "unknown"} (${info.source === "downloaded" ? "downloaded" : "built-in"})`,
    });
    if (!picked) {
      return;
    }

    if (picked.reset) {
      await this.resetToBundled();
      await vscode.window.showInformationMessage(
        `PDF Phoenix is back to its built-in pdf.js (${bundledVersion ?? "unknown"}). ${OPEN_PDFS_SWITCH}`
      );
      return;
    }

    if (picked.version) {
      const warning = majorChangeWarning(picked.version, bundledVersion ?? info.version ?? "");
      if (warning) {
        const go = await vscode.window.showWarningMessage(warning, { modal: true }, "Use It Anyway");
        if (go !== "Use It Anyway") {
          return;
        }
      }
      await this.installWithFeedback(picked.version);
    }
  }
}

export const OPEN_PDFS_SWITCH =
  "Open PDFs switch to it now, or once you save or revert them if they have unsaved changes.";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function keepDownloadedVersion(): boolean {
  return vscode.workspace.getConfiguration("pdfPhoenix").get<boolean>("pdfjs.keepDownloadedVersion", false);
}

// A usable engine folder: it has the viewer and the version marker.
async function isValidEngine(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "web", "viewer.html"));
    return (await readMetaVersion(dir)) !== null;
  } catch {
    return false;
  }
}
