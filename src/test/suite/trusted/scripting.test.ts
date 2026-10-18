import * as assert from "node:assert";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, sleep, testApi, viewer, waitFor } from "../helpers";

describe("PDF JavaScript in a trusted workspace", () => {
  afterEach(async () => {
    await closeAllEditors();
  });

  it("reports the workspace as trusted", () => {
    assert.strictEqual(vscode.workspace.isTrusted, true);
  });

  it("runs JavaScript embedded in the PDF", async () => {
    const pdf = fixture("form-script.pdf");
    const s = await openPdf(pdf);
    assert.strictEqual(s.enableScripting, true);
    await loadedSnapshot(pdf, "the open action to fill the field", (x) => x.fields.result === "script ran");
  });

  it("doesn't count what the PDF's own scripts fill in as an unsaved change, but does count edits", async () => {
    const api = await testApi();
    const pdf = fixture("form-script.pdf");
    await openPdf(pdf);
    await loadedSnapshot(pdf, "the open action to fill the field", (x) => x.fields.result === "script ran");
    await sleep(1_000);
    assert.strictEqual(api.isDirty(pdf), false, "opening the PDF isn't an edit");
    await viewer(pdf, "setField", { id: "4R", value: "typed by the user" });
    await waitFor("a real edit to mark the PDF dirty", () => api.isDirty(pdf));
  });
});
