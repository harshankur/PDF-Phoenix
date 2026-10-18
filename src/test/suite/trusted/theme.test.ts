import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  DARK_THEME,
  LIGHT_THEME,
  closeAllEditors,
  fixture,
  loadedSnapshot,
  openPdf,
  runOnPdf,
  setSetting,
  setTheme,
  sleep,
  testApi,
  viewer,
  waitFor,
} from "../helpers";

describe("Theme-matched viewing", () => {
  const pdf = fixture("sample.pdf");

  beforeEach(async () => {
    await setSetting("pdfPhoenix", "viewerTheme", undefined);
    await setSetting("pdfPhoenix", "pageColors", undefined);
    await setTheme(DARK_THEME);
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  after(async () => {
    await setSetting("pdfPhoenix", "viewerTheme", undefined);
    await setSetting("pdfPhoenix", "pageColors", undefined);
    await setTheme(DARK_THEME);
  });

  it("opens a PDF in the viewer", async () => {
    const s = await openPdf(pdf);
    assert.strictEqual(s.pagesCount, 5);
    assert.strictEqual(s.page, 1);
    assert.strictEqual(s.fakeWorker, false, `pdf.js fell back to parsing on the UI thread: ${JSON.stringify(s.log)}`);
  });

  it("matches the toolbar to the VS Code theme, live and without reloading", async () => {
    const api = await testApi();
    await openPdf(pdf);
    await loadedSnapshot(pdf, "a dark toolbar", (s) => s.colorScheme === "dark");
    const renders = api.renderCount(pdf);

    await setTheme(LIGHT_THEME);
    await loadedSnapshot(pdf, "a light toolbar", (s) => s.colorScheme === "light");
    await setTheme(DARK_THEME);
    await loadedSnapshot(pdf, "a dark toolbar again", (s) => s.colorScheme === "dark");
    assert.strictEqual(api.renderCount(pdf), renders, "a toolbar-only change should not reload the viewer");
  });

  it("keeps the document's own page colors by default", async () => {
    const s = await openPdf(pdf);
    assert.strictEqual(s.forcePageColors, false);
  });

  it("pins the toolbar with pdfPhoenix.viewerTheme", async () => {
    await openPdf(pdf);
    await setSetting("pdfPhoenix", "viewerTheme", "light");
    await loadedSnapshot(pdf, "the pinned light toolbar", (s) => s.colorScheme === "light");
    await setSetting("pdfPhoenix", "viewerTheme", "match-vscode");
    await loadedSnapshot(pdf, "the toolbar back on the dark theme", (s) => s.colorScheme === "dark");
  });

  it("recolors pages in a dark theme and reloads in place, keeping the reader's position", async () => {
    const api = await testApi();
    await openPdf(pdf);
    await viewer(pdf, "setView", { scaleValue: 1.5, rotation: 90, page: 3, sidebarOpen: false });
    await loadedSnapshot(pdf, "the view to be recorded", (s) => (s.viewState as any)?.hash?.startsWith("page=3"));
    const renders = api.renderCount(pdf);

    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await waitFor("the viewer to reload", () => api.renderCount(pdf) > renders);
    const s = await loadedSnapshot(pdf, "recolored pages", (x) => x.forcePageColors && x.page === 3);
    assert.ok(s.pageColorsBackground, "expected the editor background as page color");
    assert.ok(s.pageColorsForeground, "expected the editor foreground as text color");
    assert.strictEqual(s.page, 3);
    assert.strictEqual(s.scale, 1.5);
    assert.strictEqual(s.rotation, 90);
    assert.strictEqual(s.sidebarOpen, false);
  });

  it("returns to the document's colors when switching to a light theme", async () => {
    const api = await testApi();
    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await openPdf(pdf);
    await loadedSnapshot(pdf, "recolored pages", (s) => s.forcePageColors);
    const renders = api.renderCount(pdf);

    await setTheme(LIGHT_THEME);
    await waitFor("the viewer to reload", () => api.renderCount(pdf) > renders);
    await loadedSnapshot(pdf, "original page colors", (s) => !s.forcePageColors && s.colorScheme === "light");
  });

  it("does not reload a PDF with unsaved changes until it is saved", async () => {
    const api = await testApi();
    const form = fixture("form-plain.pdf");
    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await openPdf(form);
    await loadedSnapshot(form, "recolored pages", (s) => s.forcePageColors);
    await viewer(form, "setField", { id: "4R", value: "kept across the reload" });
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(form));
    const renders = api.renderCount(form);

    await setTheme(LIGHT_THEME);
    await loadedSnapshot(form, "the light toolbar", (s) => s.colorScheme === "light");
    await sleep(1_000);
    assert.strictEqual(api.renderCount(form), renders, "a dirty PDF must not be reloaded");
    assert.strictEqual((await loadedSnapshot(form)).forcePageColors, true);

    await runOnPdf(form, "workbench.action.files.save");
    await waitFor("the viewer to reload after saving", () => api.renderCount(form) > renders);
    const s = await loadedSnapshot(form, "original colors after the save", (x) => !x.forcePageColors);
    assert.strictEqual(api.isDirty(form), false);
    assert.strictEqual(s.fields.result, "kept across the reload", "the saved edit should survive the reload");
  });

  it("applies the pending page colors when the PDF is reverted", async () => {
    const api = await testApi();
    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await openPdf(pdf);
    await loadedSnapshot(pdf, "recolored pages", (s) => s.forcePageColors);
    await viewer(pdf, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    const renders = api.renderCount(pdf);

    await setTheme(LIGHT_THEME);
    await sleep(1_000);
    assert.strictEqual(api.renderCount(pdf), renders);

    await runOnPdf(pdf, "workbench.action.files.revert");
    await waitFor("the viewer to reload after reverting", () => api.renderCount(pdf) > renders);
    await loadedSnapshot(pdf, "original colors after the revert", (s) => !s.forcePageColors);
    assert.strictEqual(api.isDirty(pdf), false);
  });

  it("cancels a pending reload when the theme switches back before saving", async () => {
    const api = await testApi();
    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await openPdf(pdf);
    await loadedSnapshot(pdf, "recolored pages", (s) => s.forcePageColors);
    await viewer(pdf, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    const renders = api.renderCount(pdf);

    await setTheme(LIGHT_THEME);
    await loadedSnapshot(pdf, "the light toolbar", (s) => s.colorScheme === "light");
    await setTheme(DARK_THEME);
    await loadedSnapshot(pdf, "the dark toolbar", (s) => s.colorScheme === "dark");
    await runOnPdf(pdf, "workbench.action.files.save");
    await sleep(1_000);
    assert.strictEqual(api.renderCount(pdf), renders, "colors match again, so saving should not reload");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });
});
