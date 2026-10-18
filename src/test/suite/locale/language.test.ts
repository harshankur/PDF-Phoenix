import { closeAllEditors, fixture, loadedSnapshot, openPdf } from "../helpers";

describe("Display language", () => {
  afterEach(async () => {
    await closeAllEditors();
  });

  it("shows the viewer's own UI in VS Code's display language", async () => {
    const pdf = fixture("sample.pdf");
    await openPdf(pdf);
    // pdf.js's German strings label the page number box "Seite".
    await loadedSnapshot(pdf, "German viewer strings", (s) => s.toolbarPageLabel === "Seite");
  });
});
