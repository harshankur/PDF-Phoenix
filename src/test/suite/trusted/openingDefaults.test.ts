import * as assert from "node:assert";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, setSetting } from "../helpers";

const SETTINGS = ["defaultZoom", "defaultSidebar", "defaultScrollMode", "defaultSpreadMode", "defaultCursorTool"];

describe("Opening defaults", () => {
  const pdf = fixture("sample.pdf");

  async function resetSettings(): Promise<void> {
    for (const key of SETTINGS) {
      await setSetting("pdfPhoenix", key, undefined);
    }
  }

  beforeEach(resetSettings);
  after(resetSettings);
  afterEach(async () => {
    await closeAllEditors();
  });

  it("opens at Page Fit, vertical single pages, text selection", async () => {
    const s = await openPdf(pdf);
    assert.strictEqual(s.scaleValue, "page-fit");
    assert.strictEqual(s.scrollMode, 0, "vertical");
    assert.strictEqual(s.spreadMode, 0, "no spreads");
    await loadedSnapshot(pdf, "the select tool", (x) => x.cursorTool === 0);
  });

  it("shows the viewer's UI in English when VS Code is in English", async () => {
    await openPdf(pdf);
    await loadedSnapshot(pdf, "English viewer strings", (x) => x.toolbarPageLabel === "Page");
  });

  it("applies the zoom and sidebar settings", async () => {
    await setSetting("pdfPhoenix", "defaultZoom", "page-width");
    await setSetting("pdfPhoenix", "defaultSidebar", "none");
    const s = await openPdf(pdf);
    assert.strictEqual(s.scaleValue, "page-width");
    assert.strictEqual(s.sidebarOpen, false);
  });

  it("applies the scroll mode, spread mode and cursor tool settings", async () => {
    await setSetting("pdfPhoenix", "defaultScrollMode", "wrapped");
    await setSetting("pdfPhoenix", "defaultSpreadMode", "odd");
    await setSetting("pdfPhoenix", "defaultCursorTool", "hand");
    const s = await openPdf(pdf);
    assert.strictEqual(s.scrollMode, 2, "wrapped");
    assert.strictEqual(s.spreadMode, 1, "odd spreads");
    await loadedSnapshot(pdf, "the hand tool", (x) => x.cursorTool === 1);
  });

  it("falls back to the defaults for invalid values", async () => {
    await setSetting("pdfPhoenix", "defaultScrollMode", "sideways\" onload=\"alert(1)");
    await setSetting("pdfPhoenix", "defaultZoom", "huge");
    const s = await openPdf(pdf);
    assert.strictEqual(s.scrollMode, 0);
    assert.strictEqual(s.scaleValue, "page-fit");
  });
});
