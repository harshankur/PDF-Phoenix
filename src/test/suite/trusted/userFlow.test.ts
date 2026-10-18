import * as assert from "node:assert";
import * as vscode from "vscode";
import { closeAllEditors, fixture, openPdf, sleep, waitFor } from "../helpers";

// The sequence from a manual check that crashed the extension host: export a
// PDF's annotations, then open another PDF while the first stays open.
describe("Export, then open another PDF", () => {
  afterEach(async () => {
    await closeAllEditors();
  });

  it("keeps the extension host alive", async () => {
    const annotated = fixture("annotated.pdf");
    await openPdf(annotated);
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations");
    await waitFor("the exported Markdown document", () => vscode.window.activeTextEditor?.document.languageId === "markdown");
    await sleep(2_000);
    const sample = await openPdf(fixture("sample.pdf"));
    assert.strictEqual(sample.pagesCount, 5);
    await openPdf(annotated);
    await sleep(3_000);
    assert.strictEqual((await openPdf(fixture("sample.pdf"))).pagesCount, 5);
  });
});
