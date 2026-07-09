import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { unzipToDir } from "./unzip";
import { compareVersions, parseVersion, preparePdfjsDir, readMetaVersion, writeMeta } from "./pdfjs";

const RELEASES_API = "https://api.github.com/repos/mozilla/pdf.js/releases?per_page=100";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "pdfPhoenix.lastUpdateCheck";
const SKIPPED_VERSION_KEY = "pdfPhoenix.skippedVersion";

interface Release {
  version: string;
  prerelease: boolean;
}

// Owns everything about which pdf.js build is in effect: resolving between the
// bundled fallback and a downloaded copy, checking Mozilla's releases, and
// downloading/installing/resetting on request.
export class PdfjsManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get bundledDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media", "pdfjs");
  }

  private get downloadedDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "pdfjs");
  }

  // The pdf.js root the webview should load from: the downloaded copy when a
  // valid one exists, otherwise the bundled fallback.
  async activeRootUri(): Promise<vscode.Uri> {
    return (await this.hasValidDownload()) ? this.downloadedDir : this.bundledDir;
  }

  async activeInfo(): Promise<{ version: string | null; source: "downloaded" | "bundled" }> {
    if (await this.hasValidDownload()) {
      return { version: await readMetaVersion(this.downloadedDir.fsPath), source: "downloaded" };
    }
    return { version: await readMetaVersion(this.bundledDir.fsPath), source: "bundled" };
  }

  // Both roots must be reachable by the webview: bundled lives under the
  // extension dir, downloaded under global storage.
  localResourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.context.extensionUri, "media"), this.context.globalStorageUri];
  }

  private async hasValidDownload(): Promise<boolean> {
    try {
      await fs.access(path.join(this.downloadedDir.fsPath, "web", "viewer.html"));
      return (await readMetaVersion(this.downloadedDir.fsPath)) !== null;
    } catch {
      return false;
    }
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

  private async downloadZip(version: string): Promise<Buffer> {
    const url = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`download failed (${res.status}) for v${version}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- install / reset ----------

  // Download + extract into a staging dir, validate/prune/patch, then atomically
  // swap it into place. The live copy isn't touched until the very last rename,
  // so a failed or invalid download leaves the current viewer intact.
  async install(version: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PDF Phoenix: installing pdf.js v${version}`,
        cancellable: false,
      },
      async (progress) => {
        const storageRoot = this.context.globalStorageUri.fsPath;
        const staging = path.join(storageRoot, "staging");
        const target = this.downloadedDir.fsPath;

        await fs.mkdir(storageRoot, { recursive: true });
        await fs.rm(staging, { recursive: true, force: true });
        await fs.mkdir(staging, { recursive: true });

        progress.report({ message: "downloading…" });
        const zip = await this.downloadZip(version);

        progress.report({ message: "extracting…" });
        await unzipToDir(zip, staging);

        progress.report({ message: "validating…" });
        await preparePdfjsDir(staging);
        await writeMeta(staging, version);

        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(staging, target);
      }
    );
  }

  async resetToBundled(): Promise<void> {
    await fs.rm(this.downloadedDir.fsPath, { recursive: true, force: true });
  }

  private async installWithFeedback(version: string): Promise<void> {
    try {
      await this.install(version);
      await vscode.window.showInformationMessage(
        `PDF Phoenix is now using pdf.js ${version}. Already-open PDFs keep the previous version until you close and reopen them.`
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
    const activeVersion = info.version ?? "0.0.0";
    const major = parseVersion(activeVersion)?.[0];
    if (major === undefined) {
      return null;
    }
    const candidates = (await this.fetchReleases())
      .filter((r) => !r.prerelease && parseVersion(r.version)?.[0] === major)
      .sort((a, b) => compareVersions(b.version, a.version));
    const latest = candidates[0]?.version;
    if (!latest || compareVersions(latest, activeVersion) <= 0) {
      return null;
    }
    return latest;
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
        `PDF Phoenix is back to its built-in pdf.js (${bundledVersion ?? "unknown"}). Already-open PDFs keep the previous version until you close and reopen them.`
      );
      return;
    }

    if (picked.version) {
      const activeMajor = parseVersion(info.version ?? "0.0.0")?.[0];
      const pickedMajor = parseVersion(picked.version)?.[0];
      if (activeMajor !== undefined && pickedMajor !== undefined && pickedMajor !== activeMajor) {
        const go = await vscode.window.showWarningMessage(
          `pdf.js ${picked.version} is a newer major release (${pickedMajor}.x) than the one PDF Phoenix is tested with (${activeMajor}.x). ` +
            `Annotation saving, the unsaved-changes indicator, or the print-key handling may not work correctly with it. Use it anyway?`,
          { modal: true },
          "Use It Anyway"
        );
        if (go !== "Use It Anyway") {
          return;
        }
      }
      await this.installWithFeedback(picked.version);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
