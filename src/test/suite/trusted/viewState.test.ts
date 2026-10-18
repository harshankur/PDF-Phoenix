import * as assert from "node:assert";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, setSetting, testApi, viewer, waitFor } from "../helpers";

describe("Remembering where you left off", () => {
  const pdf = fixture("sample.pdf");

  beforeEach(async () => {
    await setSetting("pdfPhoenix", "rememberViewState", undefined);
    await (await testApi()).forgetViews();
  });

  afterEach(async () => {
    await setSetting("pdfPhoenix", "rememberViewState", undefined);
    await closeAllEditors();
  });

  async function leaveAt(uri: vscode.Uri, view: Record<string, unknown>, expectedHash: string): Promise<void> {
    const api = await testApi();
    await openPdf(uri);
    await viewer(uri, "setView", view);
    await waitFor("the view to be remembered", () => api.rememberedView(uri)?.hash?.startsWith(expectedHash));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }

  it("reopens a PDF at the same page, zoom, rotation and sidebar state", async () => {
    await leaveAt(pdf, { scaleValue: 1.25, rotation: 180, page: 4, sidebarOpen: false }, "page=4");
    const s = await openPdf(pdf);
    assert.strictEqual(s.page, 4);
    assert.strictEqual(s.scale, 1.25);
    assert.strictEqual(s.rotation, 180);
    assert.strictEqual(s.sidebarOpen, false);
  });

  it("remembers each PDF separately", async () => {
    // Not the last page: pdf.js remembers the top-most visible page, and the
    // last one can't scroll to the top when the window is taller than it.
    await leaveAt(pdf, { page: 3 }, "page=3");
    const other = await openPdf(fixture("form-plain.pdf"));
    assert.strictEqual(other.page, 1);
    assert.strictEqual(other.scaleValue, "page-fit");
  });

  it("opens with the defaults when turned off", async () => {
    await setSetting("pdfPhoenix", "rememberViewState", false);
    const api = await testApi();
    await openPdf(pdf);
    await viewer(pdf, "setView", { page: 3, scaleValue: 2 });
    await loadedSnapshot(pdf, "page 3", (s) => s.page === 3);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.strictEqual(api.rememberedView(pdf), undefined, "nothing should be stored");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const s = await openPdf(pdf);
    assert.strictEqual(s.page, 1);
    assert.strictEqual(s.scaleValue, "page-fit");
  });
});
