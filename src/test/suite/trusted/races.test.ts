import * as assert from "node:assert";
import * as fs from "node:fs";
import { samplePdf } from "../../fixtures";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, runOnPdf, setSetting, sleep, testApi, viewer, waitFor } from "../helpers";

describe("Reloads racing other work", () => {
  afterEach(async () => {
    await setSetting("pdfPhoenix", "pageColors", undefined);
    await closeAllEditors();
  });

  it("fails a request still waiting on the viewer as soon as the viewer rebuilds", async () => {
    const api = await testApi();
    const pdf = fixture("sample.pdf");
    await openPdf(pdf);
    // An export or import in progress looks like this to the extension.
    const pending = api.requestNeverAnswered(pdf).then(
      () => "answered",
      (err: Error) => `rejected: ${err.message}`
    );
    const renders = api.renderCount(pdf);
    await setSetting("pdfPhoenix", "pageColors", "match-dark-themes");
    await waitFor("the viewer to rebuild", () => api.renderCount(pdf) > renders);
    const outcome = await Promise.race([pending, sleep(5_000).then(() => "still waiting")]);
    assert.match(outcome, /^rejected: .*reloaded/);
  });

  it("doesn't reload over an edit made just before the file changed on disk", async () => {
    const api = await testApi();
    const pdf = fixture("external.pdf");
    fs.writeFileSync(pdf.fsPath, samplePdf(5));
    await openPdf(pdf);
    // Hold back the viewer's own 200ms edit check, so the edit below is
    // still unreported when the change on disk arrives.
    await viewer(pdf, "pauseEditWatch");
    await viewer(pdf, "markDirty");
    const renders = api.renderCount(pdf);
    fs.writeFileSync(pdf.fsPath, samplePdf(3));
    await waitFor("the edit to be noticed", () => api.isDirty(pdf), 10_000);
    await sleep(1_000);
    assert.strictEqual(api.renderCount(pdf), renders, "the viewer must not reload over the edit");
    assert.strictEqual((await loadedSnapshot(pdf)).pagesCount, 5);
  });
});

describe("Saving slowly", () => {
  afterEach(async () => {
    (await testApi()).setSaveDelay(0);
    await closeAllEditors();
  });

  it("doesn't mistake its own slow save for a change made elsewhere", async () => {
    const api = await testApi();
    const pdf = fixture("external.pdf");
    fs.writeFileSync(pdf.fsPath, samplePdf(5));
    await openPdf(pdf);
    await viewer(pdf, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    const renders = api.renderCount(pdf);
    // Longer than the grace period after a write, as on a slow drive.
    api.setSaveDelay(1_500);
    await runOnPdf(pdf, "workbench.action.files.save");
    await waitFor("the save", () => !api.isDirty(pdf), 10_000);
    await sleep(1_500);
    assert.strictEqual(api.renderCount(pdf), renders, "its own write must not reload the viewer");
  });
});
