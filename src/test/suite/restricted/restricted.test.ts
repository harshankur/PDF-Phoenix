import * as assert from "node:assert";
import * as vscode from "vscode";
import { closeAllEditors, fixture, loadedSnapshot, openPdf, revealPdf, runOnPdf, sleep, testApi, viewer, waitFor } from "../helpers";

describe("Restricted Mode", () => {
  const pdf = fixture("form-script.pdf");

  afterEach(async () => {
    await closeAllEditors();
  });

  it("runs in an untrusted workspace", () => {
    assert.strictEqual(vscode.workspace.isTrusted, false);
  });

  it("opens PDFs in the viewer with PDF JavaScript turned off", async () => {
    const s = await openPdf(pdf);
    assert.strictEqual(s.enableScripting, false);
    // Give a would-be open action every chance to run before checking.
    await sleep(2_000);
    const after = await loadedSnapshot(pdf);
    assert.strictEqual(after.fields.result, "", "the embedded script must not have run");
    assert.strictEqual(after.scriptingReady, false);
  });

  it("turns PDF JavaScript on once the workspace is trusted, after unsaved changes are saved", async () => {
    const api = await testApi();
    const plain = fixture("form-plain.pdf");
    await openPdf(pdf);
    await openPdf(plain);
    await viewer(plain, "markDirty");
    await waitFor("the edit to mark the PDF dirty", () => api.isDirty(plain));
    const scriptRenders = api.renderCount(pdf);
    const plainRenders = api.renderCount(plain);

    await api.grantTrust();
    await waitFor("the clean viewer to reload", () => api.renderCount(pdf) > scriptRenders);
    await revealPdf(pdf);
    const s = await loadedSnapshot(pdf, "scripting on and the script run", (x) => x.fields.result === "script ran");
    assert.strictEqual(s.enableScripting, true);

    await sleep(1_000);
    assert.strictEqual(api.renderCount(plain), plainRenders, "the dirty viewer must wait");
    assert.strictEqual((await loadedSnapshot(plain)).enableScripting, false);
    await runOnPdf(plain, "workbench.action.files.save");
    await waitFor("the dirty viewer to reload after saving", () => api.renderCount(plain) > plainRenders);
    await loadedSnapshot(plain, "scripting on after the save", (x) => x.enableScripting);
  });
});
