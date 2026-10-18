import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";

// Entry point VS Code loads via --extensionTestsPath. Runs the test files for
// the scenario runTests.ts launched this VS Code for.
export function run(): Promise<void> {
  const scenario = process.env.PDFPHOENIX_TEST_SCENARIO || "trusted";
  // PDFPHOENIX_TEST_GREP runs only the tests whose title matches it.
  const mocha = new Mocha({
    ui: "bdd",
    timeout: 60_000,
    color: true,
    grep: process.env.PDFPHOENIX_TEST_GREP || undefined,
  });
  // Leave nothing dirty behind: VS Code would otherwise stop at shutdown to
  // back up or ask about unsaved tabs, and never exit. Any tab still dirty
  // here is logged, since a test should have cleaned it up itself.
  mocha.suite.afterAll(async () => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.isDirty) {
          console.warn(`Tab left with unsaved changes after the tests: ${tab.label}`);
          await vscode.window.tabGroups.close(tab, true).then(undefined, () => undefined);
        }
      }
    }
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor").then(undefined, () => undefined);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
  const dir = path.join(__dirname, scenario);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort()) {
    mocha.addFile(path.join(dir, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} test(s) failed in "${scenario}"`)) : resolve()
    );
  });
}
