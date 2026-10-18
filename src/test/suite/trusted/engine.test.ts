import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, revealPdf, runOnPdf, sleep, testApi, viewer, waitFor } from "../helpers";

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
    await api.installEngineCopy("6.1.200");
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
    await api.installEngineCopy("6.1.200");
    await openPdf(clean);
    await openPdf(dirty);
    const first = api.engineRoot(dirty) ?? "";
    assert.ok(first.includes(`${path.sep}engines${path.sep}`), first);
    await viewer(dirty, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(dirty));

    await api.installEngineCopy("6.1.200");
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
    await assert.rejects(api.installEngineCopy("6.1.200", { breakViewerHtml: true }), /viewer\.html no longer contains/);
    await sleep(500);
    assert.strictEqual(api.engineRoot(pdf), root);
    assert.strictEqual(api.renderCount(pdf), renders);
  });

  it("follows an engine switch made in another VS Code window", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await api.installEngineCopy("6.1.200");
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
