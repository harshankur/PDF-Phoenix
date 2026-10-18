import * as assert from "node:assert";
import * as fs from "node:fs";
import { samplePdf } from "../../fixtures";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, runOnPdf, sleep, testApi, viewer, waitFor } from "../helpers";

describe("PDF changed on disk", () => {
  const pdf = fixture("external.pdf");

  beforeEach(() => {
    fs.writeFileSync(pdf.fsPath, samplePdf(5));
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  it("reloads a PDF without unsaved changes, keeping the reader's place", async () => {
    const api = await testApi();
    await openPdf(pdf);
    await viewer(pdf, "setView", { page: 2 });
    await loadedSnapshot(pdf, "page 2 to be recorded", (s) => (s.viewState as any)?.hash?.startsWith("page=2"));
    const renders = api.renderCount(pdf);

    fs.writeFileSync(pdf.fsPath, samplePdf(3));
    await waitFor("the viewer to reload", () => api.renderCount(pdf) > renders);
    const s = await loadedSnapshot(pdf, "the new 3-page file", (x) => x.pagesCount === 3);
    assert.strictEqual(s.page, 2);
  });

  it("keeps unsaved changes when the file changes on disk, until reverted", async () => {
    const api = await testApi();
    await openPdf(pdf);
    await viewer(pdf, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    const renders = api.renderCount(pdf);

    fs.writeFileSync(pdf.fsPath, samplePdf(3));
    await sleep(2_000);
    assert.strictEqual(api.renderCount(pdf), renders, "unsaved edits must not be thrown away");
    assert.strictEqual(api.isDirty(pdf), true);
    const kept = await loadedSnapshot(pdf);
    assert.strictEqual(kept.pagesCount, 5);
    assert.ok(kept.annotationStorageSize > 0, "the edit should still be in the viewer");

    await runOnPdf(pdf, "workbench.action.files.revert");
    await loadedSnapshot(pdf, "the file from disk after reverting", (x) => x.pagesCount === 3);
    assert.strictEqual(api.isDirty(pdf), false);
  });
});
