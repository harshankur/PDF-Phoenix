import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, runOnPdf, testApi, viewer, waitFor } from "../helpers";

// After a restart or crash with unsaved changes, VS Code reopens the editor
// with the backup PDF Phoenix wrote (backupCustomDocument). The viewer must
// show that, and saving must write it, not the older file on disk.
describe("Restoring after a hot exit", () => {
  const pdf = fixture("form-plain.pdf");
  const backup = fixture("form-plain.backup");

  afterEach(async () => {
    await closeAllEditors();
  });

  it("shows the backup, keeps it unsaved, and saves it to the file", async () => {
    const api = await testApi();
    // An unsaved edit, captured exactly as a hot exit backup would be.
    await openPdf(pdf);
    await viewer(pdf, "setField", { id: "4R", value: "kept by hot exit" });
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(pdf));
    fs.writeFileSync(backup.fsPath, await api.currentBytes(pdf));
    await runOnPdf(pdf, "workbench.action.files.revert");
    await waitFor("the revert", () => !api.isDirty(pdf));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const reopened = await openPdf(pdf);
    assert.strictEqual(reopened.fields.result, "", `the file on disk doesn't have the edit; opens: ${JSON.stringify(api.openLog())}`);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const restored = await api.openFromBackup(pdf, backup);
    try {
      const s = await loadedSnapshot(pdf, "the restored edit", (x) => x.fields.result === "kept by hot exit");
      assert.strictEqual(s.fields.result, "kept by hot exit");
      assert.strictEqual(api.isDirty(pdf), true, "a restored backup counts as unsaved");
      await restored.save();
      assert.strictEqual(api.isDirty(pdf), false);
    } finally {
      restored.close();
    }
    assert.strictEqual((await openPdf(pdf)).fields.result, "kept by hot exit", "saving wrote the restored version");
  });
});
