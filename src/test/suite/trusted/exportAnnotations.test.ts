import * as assert from "node:assert";
import * as vscode from "vscode";
import { closeAllEditors, fixture, openPdf, sleep, viewer, waitFor } from "../helpers";

const INK = 15;

// The Markdown document the export opened.
async function exported(): Promise<string> {
  const editor = await waitFor(
    "the exported Markdown document",
    () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.languageId === "markdown" && e.document.isUntitled ? e : undefined;
    },
    30_000
  );
  return editor.document.getText();
}

describe("Export Annotations to Markdown", () => {
  const pdf = fixture("annotated.pdf");

  afterEach(async () => {
    await closeAllEditors();
  });

  it("lists annotations by page with the highlighted text", async () => {
    await openPdf(pdf);
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations");
    const md = await exported();

    assert.ok(md.startsWith("# Annotations: annotated.pdf\n"), md);
    assert.ok(md.includes("4 annotations on 2 pages"), md);
    assert.ok(
      md.includes(
        "## Page 1\n\n- **Highlight** (#FFFF00, by Reviewer, 2026-10-01)\n  > annotated\n\n  Important word\n" +
          "- **Note** (#FFCC00)\n  Remember to cite this.\n"
      ),
      md
    );
    assert.ok(md.includes("## Page 2\n\n- **Highlight** (#80FF80)\n  > line of text second line\n- **Text box**\n  A text box\n"), md);
    assert.ok(!/Link|example\.com/.test(md), "links are not annotations to export");
  });

  it("includes annotations that haven't been saved yet", async () => {
    await openPdf(pdf);
    await viewer(pdf, "setEditorMode", { mode: INK });
    await sleep(500);
    await viewer(pdf, "drawInk");
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations");
    let md: string;
    try {
      md = await exported();
    } catch (err) {
      const snap = (await viewer(pdf, "snapshot")) as { log: string[] };
      throw new Error(`${err}\n      log: ${JSON.stringify(snap.log.slice(-8))}`);
    }
    assert.ok(md.includes("5 annotations on 2 pages"), md);
    assert.ok(/## Page 1\n[\s\S]*- \*\*Drawing\*\*[\s\S]*## Page 2/.test(md), md);
  });

  it("exports a PDF picked in the Explorer without opening it first", async () => {
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations", pdf);
    const md = await exported();
    assert.ok(md.includes("4 annotations on 2 pages"), md);
  });

  it("doesn't open an empty document for a PDF without annotations", async () => {
    const plain = fixture("sample.pdf");
    await openPdf(plain);
    const before = vscode.workspace.textDocuments.filter((d) => d.isUntitled).length;
    await vscode.commands.executeCommand("pdfPhoenix.exportAnnotations");
    await sleep(1_500);
    assert.strictEqual(vscode.workspace.textDocuments.filter((d) => d.isUntitled).length, before);
  });
});
