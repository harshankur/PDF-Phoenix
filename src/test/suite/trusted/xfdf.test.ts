import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { annotatedPdf } from "../../fixtures";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, runOnPdf, testApi, viewer, waitFor } from "../helpers";

interface ImportResult {
  imported: number;
  skipped: Record<string, number>;
  outsideDocument: number;
}

// The Markdown export of a PDF, as a readable check of what's in it.
async function markdownOf(pdf: vscode.Uri): Promise<string> {
  await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations", pdf);
  const editor = await waitFor(
    "the exported Markdown document",
    () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.languageId === "markdown" && e.document.isUntitled ? e : undefined;
    },
    30_000
  );
  const text = editor.document.getText();
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  return text;
}

function importInto(pdf: vscode.Uri, xfdf: vscode.Uri, ignoreDocumentId: boolean): Thenable<ImportResult | undefined> {
  return vscode.commands.executeCommand<ImportResult | undefined>("pdfPhoenix.importAnnotations", pdf, xfdf, {
    ignoreDocumentId,
  });
}

describe("XFDF export and import", () => {
  const annotated = fixture("annotated.pdf");
  const xfdf = fixture("annotated.xfdf");

  beforeEach(() => {
    fs.rmSync(xfdf.fsPath, { force: true });
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  it("exports every annotation with its geometry, note and document ID", async () => {
    await openPdf(annotated);
    const result = await vscode.commands.executeCommand<{ written: number }>(
      "pdfPhoenix.exportAnnotationsXfdf",
      annotated,
      xfdf
    );
    assert.strictEqual(result?.written, 4, "two highlights, a note and a text box; the link isn't an annotation to export");
    const xml = fs.readFileSync(xfdf.fsPath, "utf8");
    assert.ok(xml.includes('<f href="annotated.pdf"/>'), xml);
    assert.match(xml, /<ids original="[0-9a-f]+" modified="[0-9a-f]+"\/>/);
    assert.match(xml, /<highlight page="0" rect="132,694,241,722" color="#FFFF00"[^>]* title="Reviewer"[^>]* coords="132,722,241,722,132,694,241,694"><contents>Important word<\/contents><\/highlight>/);
    // (pdf.js reports a note's rect at its icon's size.)
    assert.match(xml, /<text page="0" rect="[\d.,]+" color="#FFCC00"[^>]*><contents>Remember to cite this.<\/contents><\/text>/);
    assert.ok(!/<(highlight|text|freetext)[^>]* width=/.test(xml), "no line width on unstroked annotations");
    assert.match(xml, /<highlight page="1"[^>]* coords="111,717,195,717,111,695,195,695,71,687,164,687,71,665,164,665"\/>/);
    assert.match(xml, /<freetext page="1" rect="300,500,500,540"[^>]*><contents>A text box<\/contents>/);
    assert.ok(!xml.includes("example.com"));
  });

  it("imports into a copy of the PDF, and the result saves into the file", async () => {
    const api = await testApi();
    const plain = fixture("annotated-plain.pdf");
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", annotated, xfdf);
    await openPdf(plain);

    // A different PDF (another document ID), so skip that question here.
    const result = await importInto(plain, xfdf, true);
    assert.deepStrictEqual(result, { imported: 3, skipped: { text: 1 }, outsideDocument: 0 });
    await waitFor("the import to count as an unsaved edit", () => api.isDirty(plain));

    const expectAll = (md: string): void => {
      assert.ok(md.includes("3 annotations on 2 pages"), md);
      assert.ok(md.includes("- **Highlight** (#FFFF00"), md);
      assert.ok(md.includes("  > annotated\n\n  Important word\n"), md);
      assert.ok(md.includes("  > line of text second line\n"), md);
      assert.ok(md.includes("- **Text box**\n  A text box\n"), md);
    };
    expectAll(await markdownOf(plain));

    await runOnPdf(plain, "workbench.action.files.save");
    await waitFor("the save", () => !api.isDirty(plain));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await openPdf(plain);
    expectAll(await markdownOf(plain));

    // Everything landed where it was: export the saved copy again and
    // compare positions with the original's.
    const again = fixture("annotated-plain.xfdf");
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", plain, again);
    const xml = fs.readFileSync(again.fsPath, "utf8");
    assert.match(xml, /<highlight page="0"[^>]* coords="132,722,241,722,132,694,241,694"/, xml);
    assert.match(xml, /<highlight page="1"[^>]* coords="111,717,195,717,111,695,195,695,71,687,164,687,71,665,164,665"/, xml);
    // pdf.js sizes a text box to its text, so compare its top-left corner.
    const rect = /<freetext page="1" rect="([\d.,-]+)"/.exec(xml);
    assert.ok(rect, xml);
    const [x1, , , y2] = rect[1].split(",").map(Number);
    assert.ok(Math.abs(x1 - 300) < 1 && Math.abs(y2 - 540) < 1, `text box moved to ${rect[1]}`);
  });

  it("imports without asking into the PDF the XFDF was made for", async () => {
    await openPdf(annotated);
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", annotated, xfdf);
    // ignoreDocumentId false: a mismatch would fail instead of asking.
    const result = await importInto(annotated, xfdf, false);
    assert.strictEqual(result?.imported, 3);
  });

  it("refuses an XFDF made for a different PDF when told not to ask", async () => {
    const api = await testApi();
    const plain = fixture("annotated-plain.pdf");
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", annotated, xfdf);
    await openPdf(plain);
    assert.strictEqual(await importInto(plain, xfdf, false), undefined);
    assert.strictEqual(api.isDirty(plain), false);
  });

  it("imports an XFDF written by another tool", async () => {
    const plain = fixture("annotated-plain.pdf");
    const acrobat = fixture("acrobat.xfdf");
    // Namespaced, corners in another order, a popup, spaces in the ink
    // points, styling only in <defaultstyle>, and types pdf.js can't create.
    fs.writeFileSync(
      acrobat.fsPath,
      `<?xml version="1.0" encoding="UTF-8" ?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<highlight color="#80EBFF" creationdate="D:20250101090000+01'00'" date="D:20250102090000+01'00'" flags="print"
  name="a1" page="0" rect="131.5,693.5,241.5,722.5" subject="Highlight" title="Reviewer"
  coords="132,694,241,694,132,722,241,722"><contents>From Acrobat</contents>
  <popup flags="print,nozoom,norotate" open="no" page="0" rect="600,600,780,700"/></highlight>
<ink color="#FF0000" width="2" page="1" rect="100,100,200,200" name="a2"><inklist><gesture>100,100; 150,150; 200,120</gesture></inklist></ink>
<freetext page="1" rect="300,300,500,340" name="a3"><contents>Typed in Acrobat</contents><defaultstyle>font: Helvetica 16pt; color: #0000FF</defaultstyle></freetext>
<text page="0" rect="10,10,30,30" name="a4" icon="Comment"><contents>A sticky note</contents></text>
<underline page="0" rect="0,0,10,10" coords="0,10,10,10,0,0,10,0" name="a5"/>
<highlight page="7" rect="0,0,10,10" coords="0,10,10,10,0,0,10,0" name="a6"/>
</annots>
</xfdf>`
    );
    await openPdf(plain);
    const result = await importInto(plain, acrobat, true);
    assert.deepStrictEqual(result, { imported: 3, skipped: { text: 1, underline: 1 }, outsideDocument: 1 });
    const md = await markdownOf(plain);
    assert.ok(md.includes("- **Highlight** (#80EBFF"), md);
    assert.ok(md.includes("  > annotated\n\n  From Acrobat\n"), md);
    assert.ok(md.includes("- **Drawing** (#FF0000"), md);
    assert.ok(md.includes("- **Text box**\n  Typed in Acrobat\n"), md);
  });

  it("places imports exactly on pages pdf.js isn't keeping in memory, and leaves the reader's page alone", async () => {
    // pdf.js keeps about 10 pages' worth of layers; page 20 is far enough
    // from page 1 that importing onto both drops one before the import ends.
    const long = fixture("long.pdf");
    const xfdfFile = fixture("long.xfdf");
    const box = '<contents>Far away</contents><defaultappearance>/Helv 12 Tf 0 0 0 rg</defaultappearance>';
    fs.writeFileSync(
      xfdfFile.fsPath,
      `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>
<freetext page="0" rect="300,500,500,540">${box}</freetext>
<freetext page="19" rect="300,500,500,540">${box}</freetext>
<highlight page="0" rect="72,710,300,760" coords="72,760,300,760,72,710,300,710"/>
<highlight page="19" rect="72,710,300,760" coords="72,760,300,760,72,710,300,710"/>
</annots></xfdf>`
    );
    await openPdf(long);
    const result = await importInto(long, xfdfFile, true);
    assert.strictEqual(result?.imported, 4);
    // pdf.js updates its page number from scroll events, so wait for it.
    await loadedSnapshot(long, "the reader back on page 1", (x) => x.page === 1, 5_000);

    const exported = fixture("long-again.xfdf");
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", long, exported);
    const xml = fs.readFileSync(exported.fsPath, "utf8");
    for (const page of [0, 19]) {
      assert.match(xml, new RegExp(`<highlight page="${page}"[^>]* coords="72,760,300,760,72,710,300,710"`), xml);
      const rect = new RegExp(`<freetext page="${page}" rect="([\\d.,-]+)"`).exec(xml);
      assert.ok(rect, xml);
      const [x1, , , y2] = rect[1].split(",").map(Number);
      assert.ok(Math.abs(x1 - 300) < 1 && Math.abs(y2 - 540) < 1, `page ${page + 1} text box moved to ${rect[1]}`);
    }
  });

  it("removes the whole import with a single undo", async () => {
    // A fresh copy: an earlier test saves imported annotations into
    // annotated-plain.pdf, and those (rightly) aren't undone.
    const plain = fixture("undo-target.pdf");
    fs.writeFileSync(plain.fsPath, annotatedPdf(false));
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", annotated, xfdf);
    await openPdf(plain);
    assert.strictEqual((await importInto(plain, xfdf, true))?.imported, 3);
    await viewer(plain, "undo");
    const leftover = await vscode.commands.executeCommand("pdfPhoenix.exportAnnotationsXfdf", plain, fixture("after-undo.xfdf"));
    assert.strictEqual(leftover, undefined, "nothing left to export after undoing the import");
  });

  it("rejects a file that isn't XFDF and leaves the PDF untouched", async () => {
    const api = await testApi();
    const plain = fixture("annotated-plain.pdf");
    const notXfdf = fixture("not-xfdf.xml");
    fs.writeFileSync(notXfdf.fsPath, "<html><body>not annotations</body></html>");
    await openPdf(plain);
    assert.strictEqual(await importInto(plain, notXfdf, true), undefined);
    fs.writeFileSync(notXfdf.fsPath, "this is not even XML <<<");
    assert.strictEqual(await importInto(plain, notXfdf, true), undefined);
    assert.strictEqual(api.isDirty(plain), false);
  });
});
