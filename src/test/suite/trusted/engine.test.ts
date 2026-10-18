import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { compareVersions, readMetaVersion, writeMeta } from "../../../pdfjs";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, revealPdf, runOnPdf, setSetting, sleep, testApi, viewer, waitFor } from "../helpers";

// Engines the tests install are copies of the built-in one, labelled as a
// version newer than it, the way an update downloads one. (A download no
// newer than the built-in pdf.js gives way to it; see the last suite.)
const NEWER = "99.0.0";

describe("pdf.js engine", () => {
  afterEach(async () => {
    await closeAllEditors();
  });

  it("reports a PDF it can't open instead of leaving the editor blank", async () => {
    const api = await testApi();
    const broken = fixture("broken.pdf");
    await vscode.commands.executeCommand("vscode.openWith", broken, "pdfPhoenix.viewer");
    const reason = await waitFor("an open failure to be reported", () => api.lastOpenFailure(broken));
    assert.match(reason, /invalid|pdf/i);
  });

  it("switches open PDFs to a different engine, waiting for unsaved changes", async () => {
    const api = await testApi();
    const clean = fixture("sample.pdf");
    const dirty = fixture("form-plain.pdf");
    await openPdf(clean);
    await openPdf(dirty);
    await viewer(dirty, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(dirty));
    const cleanRenders = api.renderCount(clean);
    const dirtyRenders = api.renderCount(dirty);

    // Switch to another engine (a copy of the built-in one, installed the
    // way a download is).
    await api.installEngineCopy(NEWER);
    await waitFor("the clean viewer to rebuild", () => api.renderCount(clean) > cleanRenders);
    await revealPdf(clean);
    await loadedSnapshot(clean, "the rebuilt viewer");
    await sleep(1_000);
    assert.strictEqual(api.renderCount(dirty), dirtyRenders, "the dirty viewer must wait");

    await runOnPdf(dirty, "workbench.action.files.revert");
    await waitFor("the dirty viewer to rebuild after reverting", () => api.renderCount(dirty) > dirtyRenders);
    await loadedSnapshot(dirty, "the rebuilt viewer");
  });
});

describe("pdf.js engine folders", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  afterEach(async () => {
    await closeAllEditors();
    await vscode.commands.executeCommand("pdfPhoenix.pdfjs.resetToBundled");
    (await testApi()).setEngineRetention(WEEK);
  });

  it("keeps a superseded engine's folder while a PDF with unsaved changes still uses it", async () => {
    const api = await testApi();
    api.setEngineRetention(0);
    const clean = fixture("sample.pdf");
    const dirty = fixture("form-plain.pdf");
    await api.installEngineCopy(NEWER);
    await openPdf(clean);
    await openPdf(dirty);
    const first = api.engineRoot(dirty) ?? "";
    assert.ok(first.includes(`${path.sep}engines${path.sep}`), first);
    await viewer(dirty, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(dirty));

    await api.installEngineCopy(NEWER);
    const second = await waitFor("the clean viewer to move to the new engine", () => {
      const root = api.engineRoot(clean);
      return root && root !== first ? root : undefined;
    });
    await revealPdf(clean);
    await loadedSnapshot(clean, "the rebuilt viewer");
    await sleep(500);
    assert.strictEqual(api.engineRoot(dirty), first, "the unsaved PDF stays on its engine");
    assert.ok(fs.existsSync(first), "its engine's folder must stay while it's in use");

    await runOnPdf(dirty, "workbench.action.files.revert");
    await waitFor("the reverted viewer to move to the new engine", () => api.engineRoot(dirty) === second);
    await waitFor("the unused folder to be removed", () => !fs.existsSync(first));

    await vscode.commands.executeCommand("pdfPhoenix.pdfjs.resetToBundled");
    await waitFor("both viewers back on the built-in engine", () =>
      [clean, dirty].every((uri) => api.engineRoot(uri)?.includes(`${path.sep}media${path.sep}pdfjs`))
    );
    await waitFor("the second download's folder to be removed", () => !fs.existsSync(second));
  });

  it("refuses an engine whose viewer.html PDF Phoenix can't load, keeping the current one", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await openPdf(pdf);
    const root = api.engineRoot(pdf);
    const renders = api.renderCount(pdf);
    await assert.rejects(api.installEngineCopy(NEWER, { breakViewerHtml: true }), /viewer\.html no longer contains/);
    await sleep(500);
    assert.strictEqual(api.engineRoot(pdf), root);
    assert.strictEqual(api.renderCount(pdf), renders);
  });

  it("follows an engine switch made in another VS Code window", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await api.installEngineCopy(NEWER);
    await openPdf(pdf);
    const downloaded = api.engineRoot(pdf) ?? "";
    // Another window going back to the built-in engine rewrites the shared
    // pointer file in global storage (two levels above the engine folder).
    const storage = path.dirname(path.dirname(downloaded));
    fs.writeFileSync(path.join(storage, "active-engine.json"), JSON.stringify({ dir: null }));
    await waitFor("the viewer to follow to the built-in engine", () =>
      api.engineRoot(pdf)?.includes(`${path.sep}media${path.sep}pdfjs`)
    );
    await loadedSnapshot(pdf, "the rebuilt viewer");
  });
});

describe("pdf.js after a PDF Phoenix update", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const builtIn = (root: string | undefined) => !!root?.includes(`${path.sep}media${path.sep}pdfjs`);
  const pointer = (storage: string) => JSON.parse(fs.readFileSync(path.join(storage, "active-engine.json"), "utf8"));

  afterEach(async () => {
    await closeAllEditors();
    await setSetting("pdfPhoenix", "pdfjs.keepDownloadedVersion", undefined);
    await vscode.commands.executeCommand("pdfPhoenix.pdfjs.resetToBundled");
    (await testApi()).setEngineRetention(WEEK);
  });

  it("switches from an older download in the 1.0.x layout to the newer built-in pdf.js and removes the download", async () => {
    const api = await testApi();
    api.setEngineRetention(0);
    const storage = api.engineStorage();
    // What 1.0.x left behind: one downloaded copy in "pdfjs", no pointer file.
    const legacy = path.join(storage, "pdfjs");
    const bundled = path.join(__dirname, "..", "..", "..", "..", "media", "pdfjs");
    fs.mkdirSync(storage, { recursive: true });
    fs.cpSync(bundled, legacy, { recursive: true });
    await writeMeta(legacy, "6.3.289");
    fs.rmSync(path.join(storage, "active-engine.json"), { force: true });
    assert.ok(compareVersions((await readMetaVersion(bundled)) ?? "", "6.3.289") > 0, "the built-in copy must be newer");

    const pdf = fixture("sample.pdf");
    await openPdf(pdf);
    assert.ok(builtIn(api.engineRoot(pdf)), `a newer built-in copy wins: ${api.engineRoot(pdf)}`);

    await api.retireSupersededEngine();
    assert.deepStrictEqual(pointer(storage), { dir: null });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await openPdf(pdf);
    await waitFor("the superseded download to be removed", () => !fs.existsSync(legacy));
  });

  it("switches from an older download to the newer built-in pdf.js", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await api.installEngineCopy("6.1.200");
    await openPdf(pdf);
    assert.ok(builtIn(api.engineRoot(pdf)), `${api.engineRoot(pdf)}`);
    const download = pointer(api.engineStorage()).dir;
    assert.match(download, /^v6\.1\.200-/);
    await api.retireSupersededEngine();
    assert.deepStrictEqual(pointer(api.engineStorage()), { dir: null });
  });

  it("keeps a newer download over the built-in pdf.js", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await api.installEngineCopy(NEWER);
    await openPdf(pdf);
    assert.ok(api.engineRoot(pdf)?.includes(`${path.sep}engines${path.sep}v${NEWER}-`), api.engineRoot(pdf));
    await api.retireSupersededEngine();
    assert.match(pointer(api.engineStorage()).dir, /^v99\.0\.0-/);
  });

  it("keeps an older download when keepDownloadedVersion is on, and switches once it's turned off", async () => {
    const api = await testApi();
    api.setEngineRetention(0);
    await setSetting("pdfPhoenix", "pdfjs.keepDownloadedVersion", true);
    const pdf = fixture("sample.pdf");
    await api.installEngineCopy("6.1.200");
    await openPdf(pdf);
    const kept = api.engineRoot(pdf) ?? "";
    assert.ok(kept.includes(`${path.sep}engines${path.sep}v6.1.200-`), kept);
    await api.retireSupersededEngine();
    assert.match(pointer(api.engineStorage()).dir, /^v6\.1\.200-/, "the kept download isn't retired");

    const renders = api.renderCount(pdf);
    await setSetting("pdfPhoenix", "pdfjs.keepDownloadedVersion", false);
    await waitFor("the viewer to move to the built-in engine", () => api.renderCount(pdf) > renders && builtIn(api.engineRoot(pdf)));
    await loadedSnapshot(pdf, "the rebuilt viewer");
    await waitFor("the download to be retired", () => pointer(api.engineStorage()).dir === null);
    await waitFor("the download to be removed", () => !fs.existsSync(kept));
  });
});
