import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PdfPhoenixTestApi } from "../../extension";

export const DARK_THEME = "Default Dark+";
export const LIGHT_THEME = "Default Light+";

let api: PdfPhoenixTestApi | undefined;

export async function testApi(): Promise<PdfPhoenixTestApi> {
  if (!api) {
    const ext = vscode.extensions.getExtension("harshankur.pdf-phoenix");
    assert.ok(ext, "PDF Phoenix extension not found");
    api = (await ext.activate()) as PdfPhoenixTestApi | undefined;
    assert.ok(api, "PDF Phoenix did not expose its test API (not running in ExtensionMode.Test?)");
  }
  return api;
}

export function fixture(name: string): vscode.Uri {
  const dir = process.env.PDFPHOENIX_TEST_WORKSPACE;
  assert.ok(dir, "PDFPHOENIX_TEST_WORKSPACE is not set");
  return vscode.Uri.file(path.join(dir, name));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until check() returns a truthy value (which is returned), or fail with
// the last value seen.
export async function waitFor<T>(
  description: string,
  check: () => Promise<T> | T,
  timeoutMs = 20_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) {
        return value as NonNullable<T>;
      }
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : err;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${description}; last: ${JSON.stringify(last)}`);
    }
    await sleep(200);
  }
}

export interface Snapshot {
  renderStamp: number | null;
  loaded: boolean;
  page: number | null;
  pagesCount: number;
  scale: number | null;
  scaleValue: string | null;
  rotation: number | null;
  scrollMode: number | null;
  spreadMode: number | null;
  sidebarOpen: boolean | null;
  sidebarView: number | null;
  cursorTool: number | null;
  colorScheme: string;
  bodyClass: string;
  forcePageColors: boolean;
  pageColorsBackground: string;
  pageColorsForeground: string;
  enableScripting: boolean;
  scriptingReady: boolean;
  fields: Record<string, string>;
  lang: string;
  annotationStorageSize: number;
  viewState: Record<string, unknown> | null;
  fakeWorker: boolean;
  workerSrc: string | null;
  [extra: string]: unknown;
}

// The viewer's current state. A viewer that is mid-reload can miss the
// request, so this is normally used through waitFor/loadedSnapshot.
export async function snapshot(uri: vscode.Uri): Promise<Snapshot> {
  return (await testApi()).viewer(uri, "snapshot", undefined, 2_000);
}

// Wait until the viewer has a document open and its initial view applied,
// optionally until a condition on its state holds as well.
export async function loadedSnapshot(
  uri: vscode.Uri,
  description = "the PDF to load",
  condition: (s: Snapshot) => boolean = () => true,
  timeoutMs = 20_000
): Promise<Snapshot> {
  let last: Snapshot | undefined;
  try {
    return await waitFor(
      description,
      async () => {
        const s = await snapshot(uri);
        last = s;
        // Only the page from the viewer's latest build counts: right after
        // a rebuild starts, the previous page can still be the one answering.
        const current = (await testApi()).renderStamp(uri);
        return s.loaded && s.renderStamp === current && condition(s) ? s : undefined;
      },
      timeoutMs
    );
  } catch (err) {
    if (last) {
      const { fields, viewState, page, scale, rotation, colorScheme, bodyClass, forcePageColors, enableScripting, loaded } = last;
      const brief = { loaded, page, scale, rotation, colorScheme, bodyClass, forcePageColors, enableScripting, fields, viewState, log: last.log, pdfjsLoaded: last.pdfjsLoaded, fakeWorker: last.fakeWorker };
      throw new Error(`${err instanceof Error ? err.message : err}\n      last snapshot: ${JSON.stringify(brief)}`);
    }
    throw err;
  }
}

export async function openPdf(uri: vscode.Uri): Promise<Snapshot> {
  opened.add(uri.toString());
  await vscode.commands.executeCommand("vscode.openWith", uri, "pdfPhoenix.viewer");
  return loadedSnapshot(uri);
}

export async function viewer(uri: vscode.Uri, action: string, args?: unknown): Promise<unknown> {
  return (await testApi()).viewer(uri, action, args);
}

export async function setSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

export async function setTheme(theme: string): Promise<void> {
  await setSetting("workbench", "colorTheme", theme);
}

const opened = new Set<string>();

// Close every editor without a save prompt (reverting each PDF that has
// unsaved edits first) and forget remembered views.
export async function closeAllEditors(): Promise<void> {
  const api = await testApi();
  for (const key of opened) {
    const uri = vscode.Uri.parse(key);
    if (api.isDirty(uri)) {
      await runOnPdf(uri, "workbench.action.files.revert");
    }
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  opened.clear();
  // Each test starts from the opening defaults, not where a previous test
  // left a PDF.
  await api.forgetViews();
}

// Run a command with the given PDF's editor active.
export async function runOnPdf(uri: vscode.Uri, command: string): Promise<void> {
  opened.add(uri.toString());
  await vscode.commands.executeCommand("vscode.openWith", uri, "pdfPhoenix.viewer");
  await vscode.commands.executeCommand(command);
}

// Bring a PDF's tab to the front. A viewer rebuilt while its tab is in the
// background only finishes loading once it's shown: pdf.js waits for an
// animation frame, which browsers pause in hidden pages.
export async function revealPdf(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", uri, "pdfPhoenix.viewer");
}
