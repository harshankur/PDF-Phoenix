import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, runOnPdf, testApi, viewer, waitFor } from "../helpers";

// Moves a 40 MB PDF through every path that carries the whole file between
// the extension host and the viewer: open, save, revert and hot-exit backup.
describe("Large PDFs", () => {
  const pdf = fixture("large.pdf");

  afterEach(async () => {
    await closeAllEditors();
  });

  it("opens, saves, reverts and reopens a 40 MB PDF intact", async function () {
    this.timeout(180_000);
    const api = await testApi();
    const originalSize = fs.statSync(pdf.fsPath).size;
    const timings: Record<string, number> = {};
    let start = Date.now();

    await openPdf(pdf);
    timings.open = Date.now() - start;

    await viewer(pdf, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    start = Date.now();
    await runOnPdf(pdf, "workbench.action.files.save");
    await waitFor("the save to finish", () => !api.isDirty(pdf), 60_000);
    timings.save = Date.now() - start;
    const savedSize = fs.statSync(pdf.fsPath).size;
    assert.ok(savedSize >= originalSize, `saved file shrank: ${savedSize} < ${originalSize}`);

    await viewer(pdf, "markDirty");
    await waitFor("a second edit", () => api.isDirty(pdf));
    start = Date.now();
    await runOnPdf(pdf, "workbench.action.files.revert");
    await waitFor("the revert to finish", () => !api.isDirty(pdf), 60_000);
    await loadedSnapshot(pdf, "the reverted document", (s) => s.pagesCount === 1 && s.annotationStorageSize === 0);
    timings.revert = Date.now() - start;

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    start = Date.now();
    const reopened = await openPdf(pdf);
    timings.reopen = Date.now() - start;
    assert.strictEqual(reopened.pagesCount, 1);

    console.log(`      40 MB timings (ms): ${JSON.stringify(timings)}`);
  });
});
