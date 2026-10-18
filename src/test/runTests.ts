import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { annotatedPdf, formPdf, largePdf, samplePdf } from "./fixtures";

// Runs the integration suites in a real, downloaded VS Code. Each scenario
// gets a fresh workspace (with the fixture PDFs), a fresh user profile and
// its own suite folder under out/test/suite/<scenario>.
//
// @vscode/test-electron's runTests() always passes --disable-workspace-trust,
// which makes Restricted Mode untestable, so VS Code is launched here with
// the same flags minus that one where a scenario needs trust enforced.
//
//   npm test                         all scenarios on the latest stable VS Code
//   npm test -- restricted           just the named scenario(s)
//   PDFPHOENIX_VSCODE_VERSION=1.130.0 npm test  a specific VS Code release
//   PDFPHOENIX_TEST_EXTENSIONS_DIR=<dir> npm test  alongside the extensions
//                                    installed in <dir> (use a copy: VS Code
//                                    may update files in it)

interface Scenario {
  name: string;
  // false: workspace trust is enforced and the folder opens in Restricted Mode.
  trusted: boolean;
  settings?: Record<string, unknown>;
  args?: string[];
  // Extra environment for the VS Code under test.
  env?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  { name: "trusted", trusted: true },
  {
    name: "restricted",
    trusted: false,
    // Open straight into Restricted Mode instead of asking.
    settings: { "security.workspace.trust.startupPrompt": "never", "security.workspace.trust.enabled": true },
  },
  // VS Code only changes its own display language with a language pack and
  // a restart, so the extension takes the language from here in test mode.
  { name: "locale", trusted: true, env: { PDFPHOENIX_TEST_LANGUAGE: "de" } },
];

const BASE_SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": "Default Dark+",
  "workbench.startupEditor": "none",
  "window.restoreWindows": "none",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "workbench.tips.enabled": false,
  "chat.disableAIFeatures": true,
};

function writeFixtures(dir: string, scenario: Scenario): void {
  fs.writeFileSync(path.join(dir, "sample.pdf"), samplePdf(5));
  fs.writeFileSync(path.join(dir, "form-script.pdf"), formPdf(true));
  fs.writeFileSync(path.join(dir, "form-plain.pdf"), formPdf(false));
  fs.writeFileSync(path.join(dir, "annotated.pdf"), annotatedPdf());
  fs.writeFileSync(path.join(dir, "annotated-plain.pdf"), annotatedPdf(false));
  fs.writeFileSync(path.join(dir, "long.pdf"), samplePdf(20));
  fs.writeFileSync(path.join(dir, "broken.pdf"), "This is not a PDF file, just text with a .pdf name.\n");
  if (scenario.name === "trusted") {
    fs.writeFileSync(path.join(dir, "large.pdf"), largePdf(40 * 1024 * 1024));
  }
}

function run(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../..");
  const wanted = process.argv.slice(2);
  const scenarios = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;
  if (!scenarios.length) {
    throw new Error(`no scenario named ${wanted.join(", ")} (have ${SCENARIOS.map((s) => s.name).join(", ")})`);
  }

  const executable = await downloadAndUnzipVSCode(process.env.PDFPHOENIX_VSCODE_VERSION || "stable");
  const failed: string[] = [];

  for (const scenario of scenarios) {
    // The real path: on macOS the temp folder is behind a symlink (/var ->
    // /private/var), and VS Code won't serve webview files from global
    // storage (where downloaded pdf.js engines live) through it.
    // Kept short: VS Code's IPC socket lives in the profile folder, and
    // macOS limits socket paths to 103 characters.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pp-${scenario.name.slice(0, 4)}-`)));
    const workspace = path.join(tmp, "workspace");
    const userData = path.join(tmp, "u");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    writeFixtures(workspace, scenario);
    fs.writeFileSync(
      path.join(userData, "User", "settings.json"),
      JSON.stringify({ ...BASE_SETTINGS, ...scenario.settings }, null, 2)
    );

    const args = [
      workspace,
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-cached-data",
      ...(process.env.PDFPHOENIX_TEST_EXTENSIONS_DIR
        ? [`--extensions-dir=${process.env.PDFPHOENIX_TEST_EXTENSIONS_DIR}`]
        : ["--disable-extensions", `--extensions-dir=${path.join(tmp, "extensions")}`]),
      `--user-data-dir=${userData}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(__dirname, "suite", "index")}`,
      ...(scenario.trusted ? ["--disable-workspace-trust"] : []),
      ...(scenario.args ?? []),
    ];

    console.log(`\n=== PDF Phoenix tests: ${scenario.name} ===`);
    const code = await run(executable, args, {
      ...scenario.env,
      PDFPHOENIX_TEST_SCENARIO: scenario.name,
      PDFPHOENIX_TEST_WORKSPACE: workspace,
    });
    if (code !== 0) {
      failed.push(scenario.name);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failed.length) {
    console.error(`\nFailed scenarios: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll scenarios passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
