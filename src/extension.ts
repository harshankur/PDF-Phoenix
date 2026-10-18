import * as path from "node:path";
import * as vscode from "vscode";
import { ExportedPage, annotationsToMarkdown, countAnnotations } from "./annotationsExport";
import { annotationsToXfdf, describeTypeCounts } from "./xfdf";
import { VIEWER_HTML_ANCHORS, replaceAnchor } from "./pdfjs";
import { OPEN_PDFS_SWITCH, PdfjsManager } from "./pdfjsManager";

// Returned from activate() only when VS Code runs the extension's own
// integration tests (ExtensionMode.Test), so the tests can drive and inspect
// the viewer. Normal and development runs get undefined and the webview's test
// hooks stay switched off.
export interface PdfPhoenixTestApi {
  // Run a test action in the viewer for this PDF (see runTestAction in
  // media/init.js) and resolve with its result.
  viewer(uri: vscode.Uri, action: string, args?: unknown, timeoutMs?: number): Promise<any>;
  // How many times the viewer for this PDF has been (re)built.
  renderCount(uri: vscode.Uri): number;
  // The stamp of its latest build; a snapshot reports the stamp of the page
  // that answered, so a stale page can be told from the current one.
  renderStamp(uri: vscode.Uri): number | undefined;
  // Whether the PDF has edits since it was opened, saved or reverted.
  isDirty(uri: vscode.Uri): boolean;
  // Run what happens when VS Code reports that the workspace became trusted.
  grantTrust(): Promise<void>;
  // The last error the viewer for this PDF reported while opening it.
  lastOpenFailure(uri: vscode.Uri): string | undefined;
  // How many hot-exit backups VS Code has had PDF Phoenix write for this PDF.
  backupCount(uri: vscode.Uri): number;
  // The pdf.js folder this PDF's viewer was built from.
  engineRoot(uri: vscode.Uri): string | undefined;
  // Install a copy of the bundled pdf.js as if downloaded (no network).
  installEngineCopy(version: string, options?: { breakViewerHtml?: boolean }): Promise<void>;
  // A request to the viewer that it never answers, as an export or import
  // still running would be.
  requestNeverAnswered(uri: vscode.Uri): Promise<unknown>;
  // Make saves take this much longer before writing, like a slow drive.
  setSaveDelay(ms: number): void;
  // How long superseded pdf.js folders are kept (0: as soon as unused).
  setEngineRetention(ms: number): void;
  // Where downloaded pdf.js copies live (global storage).
  engineStorage(): string;
  // The startup step that retires a download the built-in pdf.js superseded.
  retireSupersededEngine(): Promise<void>;
  // Each openCustomDocument call: "uri <- backupId" or "uri <- disk".
  openLog(): string[];
  // The bytes the viewer would save for this PDF (what a backup contains).
  currentBytes(uri: vscode.Uri): Promise<Uint8Array>;
  // Open a PDF the way VS Code does when restoring it after a hot exit:
  // openCustomDocument with the backup's id, then resolveCustomEditor in a
  // new panel. (VS Code discards backups when a test instance shuts down, so
  // a real restart can't be tested.) save/close act on that restored editor.
  openFromBackup(uri: vscode.Uri, backup: vscode.Uri): Promise<{ save(): Promise<void>; close(): void }>;
  // The view remembered for this PDF (pdfPhoenix.rememberViewState).
  rememberedView(uri: vscode.Uri): ViewState | undefined;
  // Forget every remembered view, so each test starts from the defaults.
  forgetViews(): Promise<void>;
}

// Where the reader was in a PDF, as the viewer reports it: pdf.js's own
// "page=N&zoom=Z,left,top" location plus the panel and layout modes.
export interface ViewState {
  hash?: string;
  rotation?: number;
  sidebarView?: number;
  scrollMode?: number;
  spreadMode?: number;
}

const VIEW_STATES_KEY = "pdfPhoenix.viewStates";
const MAX_VIEW_STATES = 200;

// Keep only well-formed fields: the state comes from the webview and is
// handed back to the next one, so nothing else should ride along.
function sanitizeViewState(input: unknown): ViewState | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const view: ViewState = {};
  if (typeof raw.hash === "string" && raw.hash.length <= 200 && /^[A-Za-z0-9=&.,_-]*$/.test(raw.hash)) {
    view.hash = raw.hash;
  }
  const int = (value: unknown, min: number, max: number): number | undefined =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : undefined;
  view.rotation = [0, 90, 180, 270].includes(raw.rotation as number) ? (raw.rotation as number) : undefined;
  view.sidebarView = int(raw.sidebarView, 0, 10);
  view.scrollMode = int(raw.scrollMode, 0, 3);
  view.spreadMode = int(raw.spreadMode, 0, 2);
  for (const key of Object.keys(view) as Array<keyof ViewState>) {
    if (view[key] === undefined) {
      delete view[key];
    }
  }
  return Object.keys(view).length ? view : undefined;
}

// Post a request to a viewer and call fail() if it can't be delivered (the
// viewer closed, or is closing), so its caller isn't left waiting for an
// answer that can't come until the request times out. During shutdown that
// caller can be VS Code backing up an unsaved PDF.
function postRequest(panel: vscode.WebviewPanel, message: unknown, fail: (err: Error) => void): void {
  try {
    panel.webview.postMessage(message).then(
      (delivered) => {
        if (!delivered) {
          fail(new Error("the PDF viewer isn't available."));
        }
      },
      (err: unknown) => fail(err instanceof Error ? err : new Error(String(err)))
    );
  } catch (err) {
    fail(err instanceof Error ? err : new Error(String(err)));
  }
}

// A minimal page for when the viewer itself can't be built.
function errorPage(message: string): string {
  return (
    `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">` +
    `<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:2em;}</style></head>` +
    `<body><p>${escapeAttribute(message)}</p></body></html>`
  );
}

// For JSON (or any text) placed inside a double-quoted HTML attribute.
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function activate(context: vscode.ExtensionContext): PdfPhoenixTestApi | undefined {
  const manager = new PdfjsManager(context);
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const provider = new PdfViewerProvider(context.extensionUri, manager, testMode, context.workspaceState);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => provider.onDidChangeConfiguration(event)),
    vscode.window.registerCustomEditorProvider(
      "pdfPhoenix.viewer",
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    // From the Explorer's context menu the PDF arrives as an argument; from
    // the Command Palette or the editor's menu it's the active PDF tab.
    vscode.commands.registerCommand("pdfPhoenix.exportAnnotations", (uri?: vscode.Uri) =>
      provider.exportAnnotations(uri instanceof vscode.Uri ? uri : undefined)
    ),
    // These two also take the XFDF file (and, for import, whether to skip the
    // different-document check) so they can run without dialogs, as the
    // tests and other extensions do.
    vscode.commands.registerCommand("pdfPhoenix.exportAnnotationsXfdf", (uri?: vscode.Uri, destination?: vscode.Uri) =>
      provider.exportAnnotationsXfdf(
        uri instanceof vscode.Uri ? uri : undefined,
        destination instanceof vscode.Uri ? destination : undefined
      )
    ),
    vscode.commands.registerCommand(
      "pdfPhoenix.importAnnotations",
      (uri?: vscode.Uri, source?: vscode.Uri, options?: { ignoreDocumentId?: boolean }) =>
        provider.importAnnotations(
          uri instanceof vscode.Uri ? uri : undefined,
          source instanceof vscode.Uri ? source : undefined,
          options
        )
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.checkForUpdate", () =>
      manager.commandCheckForUpdate()
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.selectVersion", () =>
      manager.commandSelectVersion()
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.resetToBundled", async () => {
      await manager.resetToBundled();
      // Not awaited: the command is done once the engine is switched, not
      // once the user dismisses the confirmation.
      void vscode.window.showInformationMessage(`PDF Phoenix is back to its built-in pdf.js. ${OPEN_PDFS_SWITCH}`);
    })
  );

  context.subscriptions.push(
    // Viewers built in Restricted Mode have PDF JavaScript off; viewers built
    // on a different pdf.js are on the wrong engine. Either way, rebuild.
    vscode.workspace.onDidGrantWorkspaceTrust(() => provider.rebuildAll()),
    manager.onDidChangeEngine(() => provider.rebuildAll())
  );

  // After an extension update, a download no newer than the new built-in
  // pdf.js is retired (unless pdfPhoenix.pdfjs.keepDownloadedVersion). Then
  // pick up engine switches made in other windows.
  void manager
    .retireSupersededDownload()
    .catch((err) => console.error("PDF Phoenix could not retire a superseded pdf.js:", err))
    .then(() => manager.startWatching())
    .then((watcher) => context.subscriptions.push(watcher));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pdfPhoenix.pdfjs.keepDownloadedVersion")) {
        void manager.onKeepDownloadedVersionChanged();
      }
    })
  );

  if (testMode) {
    return provider.testApi();
  }

  // Fire-and-forget: throttled internally, never blocks activation.
  void manager.maybeAutoCheck();
  return undefined;
}

export function deactivate(): void {
  // Nothing to clean up.
}

interface PendingReply {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  docKey: string;
}

interface PendingTestRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingByteRequest {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  docKey: string;
}

const BYTE_REQUEST_TIMEOUT_MS = 10_000;

// How long after our own write finishes to trust that a resulting file-watcher
// event is an echo of that write rather than a genuine external change. (The
// write itself is covered for however long it takes.) A time window rather
// than a one-shot flag consumed by the next event is self-healing: it can't
// get stuck if the write fails before any watcher event arrives, and it still
// absorbs a filesystem that fires the watcher more than once for one write.
const OWN_WRITE_SUPPRESS_MS = 1_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A webview URI for a directory, with a trailing slash preserved. pdf.js builds
// each asset URL by concatenating a filename onto the configured base (e.g.
// cMapUrl + "78-EUC-H.bcmap"), so the base must end in "/". asWebviewUri drops
// any trailing slash from the input path, so it's re-appended here.
function dirUri(webview: vscode.Webview, parent: vscode.Uri, name: string): string {
  return `${webview.asWebviewUri(vscode.Uri.joinPath(parent, name))}/`;
}

// A PDF open in PDF Phoenix. When VS Code restores an editor after a hot
// exit (a restart or crash with unsaved changes), restoreFrom is the backup
// it saved for it, which is what the viewer must show until the user saves
// or reverts, not the file on disk.
class PdfPhoenixDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    public restoreFrom: vscode.Uri | undefined
  ) {}
  dispose(): void {
    // Nothing held.
  }
}

class PdfViewerProvider implements vscode.CustomEditorProvider<vscode.CustomDocument> {
  // CustomDocumentContentChangeEvent (not CustomDocumentEditEvent): the dirty
  // indicator only clears via an explicit save or revert, never on its own
  // from undoing back to a clean state. The edit-stack alternative was
  // tried and reverted - firing a new edit for every hash change,
  // including changes caused by undo/redo itself, can double-count against
  // VS Code's own position-based "clean" check and report false-clean
  // (content still differs from disk) rather than just failing to clear a
  // dirty dot. That's the wrong direction to be wrong in. pdf.js's own
  // undo/redo inside the webview still works regardless; it just isn't
  // reflected in this indicator.
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<vscode.CustomDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly renders = new Map<string, () => Promise<void>>();
  // Documents with edits since they were last opened, saved or reverted -
  // exactly when VS Code shows the unsaved-changes dot (see the note above).
  private readonly dirty = new Set<string>();
  // Documents whose viewer was built with page colors that no longer match
  // the theme/pdfPhoenix.pageColors. Reloading would drop unsaved edits, so
  // those wait here for the next save or revert.
  private readonly pageColorsStale = new Set<string>();
  // Documents whose viewer was built before the workspace was trusted (PDF
  // JavaScript off) or on a pdf.js that has since been switched. Same
  // save-or-revert wait as above, but not cancellable.
  private readonly rebuildPending = new Set<string>();
  private readonly openFailures = new Map<string, string>();
  private readonly pendingByteRequests = new Map<string, PendingByteRequest>();
  private readonly pendingTestRequests = new Map<string, PendingTestRequest>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  // The PDF tab most recently focused, for commands run without a file.
  private activeKey: string | undefined;
  private readonly renderCounts = new Map<string, number>();
  private trustedForTests = false;
  // The pdf.js folder each open viewer was built from, so a superseded
  // engine's folder isn't removed while a viewer still loads from it.
  private readonly engineRoots = new Map<string, string>();
  // Each open viewer's latest render stamp (see buildHtml).
  private readonly renderStamps = new Map<string, number>();
  private readonly backupCounts = new Map<string, number>();
  private readonly openedWithBackup: string[] = [];
  // Stamped into every viewer's HTML; see buildHtml.
  private renderGeneration = 0;
  // Documents whose file changed on disk while they had unsaved edits, and
  // whose user has already been told (see the file watcher).
  private readonly externalChangeWarned = new Set<string>();
  // Until when file-watcher events for a document are taken to be echoes of
  // PDF Phoenix's own save (Infinity while the write is in progress).
  private readonly ownWriteUntil = new Map<string, number>();
  private saveDelayForTests = 0;
  private nextRequestId = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pdfjs: PdfjsManager,
    private readonly testMode: boolean,
    private readonly workspaceState: vscode.Memento
  ) {}

  private viewStates(): Record<string, { view: ViewState; at: number }> {
    return this.workspaceState.get<Record<string, { view: ViewState; at: number }>>(VIEW_STATES_KEY, {});
  }

  private rememberedView(key: string): ViewState | undefined {
    if (!vscode.workspace.getConfiguration("pdfPhoenix").get<boolean>("rememberViewState", true)) {
      return undefined;
    }
    return sanitizeViewState(this.viewStates()[key]?.view);
  }

  private async rememberView(key: string, input: unknown): Promise<void> {
    if (!vscode.workspace.getConfiguration("pdfPhoenix").get<boolean>("rememberViewState", true)) {
      return;
    }
    const view = sanitizeViewState(input);
    if (!view) {
      return;
    }
    const states = { ...this.viewStates(), [key]: { view, at: Date.now() } };
    // Keep the most recently viewed PDFs only.
    const keys = Object.keys(states);
    if (keys.length > MAX_VIEW_STATES) {
      keys
        .sort((a, b) => states[a].at - states[b].at)
        .slice(0, keys.length - MAX_VIEW_STATES)
        .forEach((old) => delete states[old]);
    }
    await this.workspaceState.update(VIEW_STATES_KEY, states);
  }

  testApi(): PdfPhoenixTestApi {
    return {
      viewer: (uri, action, args, timeoutMs = 3_000) => {
        const panel = this.panels.get(uri.toString());
        if (!panel) {
          return Promise.reject(new Error(`no PDF Phoenix editor open for ${uri.toString()}`));
        }
        const requestId = `test-${this.nextRequestId++}`;
        const promise = new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingTestRequests.delete(requestId);
            reject(new Error(`viewer did not answer "${action}" within ${timeoutMs}ms`));
          }, timeoutMs);
          this.pendingTestRequests.set(requestId, { resolve, reject, timeout });
        });
        postRequest(panel, { type: "pdfphoenix-test", requestId, action, args }, (err) => {
          const pending = this.pendingTestRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingTestRequests.delete(requestId);
            pending.reject(err);
          }
        });
        return promise;
      },
      renderCount: (uri) => this.renderCounts.get(uri.toString()) ?? 0,
      renderStamp: (uri) => this.renderStamps.get(uri.toString()),
      isDirty: (uri) => this.dirty.has(uri.toString()),
      grantTrust: () => {
        // VS Code has no API to grant trust, so mirror what a real grant
        // changes: the trust state, then the event.
        this.trustedForTests = true;
        return this.rebuildAll();
      },
      lastOpenFailure: (uri) => this.openFailures.get(uri.toString()),
      backupCount: (uri) => this.backupCounts.get(uri.toString()) ?? 0,
      openLog: () => this.openedWithBackup.slice(),
      engineRoot: (uri) => this.engineRoots.get(uri.toString()),
      installEngineCopy: (version, options) => this.pdfjs.installBundledCopyForTests(version, options),
      setEngineRetention: (ms) => this.pdfjs.setRetentionForTests(ms),
      engineStorage: () => this.pdfjs.storagePath,
      retireSupersededEngine: () => this.pdfjs.retireSupersededDownload(),
      setSaveDelay: (ms) => {
        this.saveDelayForTests = ms;
      },
      requestNeverAnswered: (uri) => this.request(uri.toString(), "neverAnswer", 120_000),
      currentBytes: (uri) => this.requestBytes({ uri, dispose: () => undefined }),
      openFromBackup: async (uri, backup) => {
        const document = this.openCustomDocument(uri, { backupId: backup.toString(), untitledDocumentData: undefined });
        const panel = vscode.window.createWebviewPanel("pdfPhoenix.viewer", path.basename(uri.fsPath), vscode.ViewColumn.Active);
        await this.resolveCustomEditor(document, panel);
        return {
          save: () => this.saveCustomDocument(document),
          close: () => panel.dispose(),
        };
      },
      rememberedView: (uri) => sanitizeViewState(this.viewStates()[uri.toString()]?.view),
      forgetViews: async () => {
        await this.workspaceState.update(VIEW_STATES_KEY, undefined);
      },
    };
  }

  // The toolbar theme updates in place; the webview works out for itself
  // whether its page colors are now stale and reports back.
  onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent): void {
    if (
      !event.affectsConfiguration("pdfPhoenix.viewerTheme") &&
      !event.affectsConfiguration("pdfPhoenix.pageColors")
    ) {
      return;
    }
    const { viewerTheme, pageColors } = this.readViewerDefaults();
    for (const panel of this.panels.values()) {
      panel.webview.postMessage({ type: "pdfphoenix-theme-settings", viewerTheme, pageColors });
    }
  }

  private async releaseUnusedEngines(): Promise<void> {
    try {
      await this.pdfjs.removeUnusedEngines(new Set(this.engineRoots.values()));
    } catch (err) {
      console.error("PDF Phoenix could not remove unused pdf.js copies:", err);
    }
  }

  // Rebuild every open viewer from current state: right away when it has no
  // unsaved changes, otherwise after its next save or revert.
  async rebuildAll(): Promise<void> {
    for (const key of this.panels.keys()) {
      this.rebuildPending.add(key);
      await this.rerenderIfStale(key);
    }
  }

  // Whether the PDF has unsaved edits, including one made so recently that
  // the viewer's 200ms check hasn't reported it yet: it's asked to check now,
  // so a reload can't silently drop an edit made just before it.
  private async hasUnsavedEdits(key: string): Promise<boolean> {
    if (this.dirty.has(key)) {
      return true;
    }
    try {
      return (await this.request<boolean>(key, "flushEdits", 2_000)) === true || this.dirty.has(key);
    } catch {
      return this.dirty.has(key);
    }
  }

  // Requests waiting on a viewer that's going away (closed, or replaced by a
  // rebuild) will never be answered: fail them now instead of letting their
  // callers wait out the timeout.
  private rejectPendingFor(key: string, reason: string): void {
    for (const [requestId, pending] of this.pendingReplies) {
      if (pending.docKey === key) {
        clearTimeout(pending.timeout);
        this.pendingReplies.delete(requestId);
        pending.reject(new Error(reason));
      }
    }
    for (const [requestId, pending] of this.pendingByteRequests) {
      if (pending.docKey === key) {
        clearTimeout(pending.timeout);
        this.pendingByteRequests.delete(requestId);
        pending.reject(new Error(`PDF Phoenix: ${reason}`));
      }
    }
  }

  private isStale(key: string): boolean {
    return this.pageColorsStale.has(key) || this.rebuildPending.has(key);
  }

  // Reload a viewer built with settings that no longer apply (page colors or
  // workspace trust), now that doing so can't throw away unsaved edits. A
  // failure is reported rather than thrown so it can't turn an otherwise
  // successful save into a failed one.
  // checkEdits: false for a revert, which discards edits anyway.
  private async rerenderIfStale(key: string, { checkEdits = true } = {}): Promise<void> {
    const render = this.renders.get(key);
    if (!render || !this.isStale(key)) {
      return;
    }
    if (checkEdits && (await this.hasUnsavedEdits(key))) {
      // Stays stale until the next save or revert.
      return;
    }
    try {
      await render();
    } catch (err) {
      await vscode.window.showErrorMessage(
        `PDF Phoenix could not reload ${path.basename(vscode.Uri.parse(key).fsPath)} with the new settings: ${messageOf(err)}`
      );
    }
  }

  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): vscode.CustomDocument {
    if (this.testMode) {
      this.openedWithBackup.push(`${uri.toString()} <- ${openContext.backupId ?? "disk"}`);
    }
    return new PdfPhoenixDocument(uri, openContext.backupId ? vscode.Uri.parse(openContext.backupId) : undefined);
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const key = document.uri.toString();
    this.panels.set(key, panel);
    if (panel.active) {
      this.activeKey = key;
    }
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activeKey = key;
      }
    });

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.pdfjs.localResourceRoots(),
    };

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "pdfphoenix-ready": {
          try {
            await this.postDocument(panel, document);
          } catch (err) {
            await vscode.window.showErrorMessage(
              `PDF Phoenix could not open ${path.basename(document.uri.fsPath)}: ${messageOf(err)}`
            );
          }
          break;
        }
        case "pdfphoenix-open-failed": {
          const reason = typeof message.message === "string" ? message.message : "unknown error";
          this.openFailures.set(key, reason);
          void this.reportOpenFailure(document, reason);
          break;
        }
        case "pdfphoenix-view-state": {
          await this.rememberView(key, message.view);
          break;
        }
        case "pdfphoenix-dirty": {
          this.dirty.add(key);
          this.changeEmitter.fire({ document });
          break;
        }
        case "pdfphoenix-page-colors-stale": {
          if (!message.stale) {
            this.pageColorsStale.delete(key);
          } else {
            this.pageColorsStale.add(key);
            await this.rerenderIfStale(key);
          }
          break;
        }
        case "pdfphoenix-bytes": {
          const pending = this.pendingByteRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingByteRequests.delete(message.requestId);
            if (message.data instanceof Uint8Array) {
              pending.resolve(message.data);
            } else {
              pending.reject(new Error("PDF Phoenix: the PDF viewer sent back data in an unexpected format."));
            }
          }
          break;
        }
        case "pdfphoenix-reply": {
          const pending = this.pendingReplies.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingReplies.delete(message.requestId);
            if (message.error) {
              pending.reject(new Error(message.error));
            } else {
              pending.resolve(message.result);
            }
          }
          break;
        }
        case "pdfphoenix-test-result": {
          const pending = this.pendingTestRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingTestRequests.delete(message.requestId);
            if (message.error) {
              pending.reject(new Error(message.error));
            } else {
              pending.resolve(message.result);
            }
          }
          break;
        }
        case "pdfphoenix-bytes-error": {
          const pending = this.pendingByteRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingByteRequests.delete(message.requestId);
            pending.reject(new Error(`PDF Phoenix: ${message.message}`));
          }
          break;
        }
      }
    });

    const render = async () => {
      // A fresh viewer is built from the current theme, settings and trust.
      this.pageColorsStale.delete(key);
      this.rebuildPending.delete(key);
      this.renderCounts.set(key, (this.renderCounts.get(key) ?? 0) + 1);
      this.openFailures.delete(key);
      // The page answering requests is about to be replaced.
      this.rejectPendingFor(key, "the PDF viewer reloaded before it could respond.");
      let html: string;
      try {
        // Resolved fresh each render so a rebuild picks up an engine switch.
        const root = await this.pdfjs.activeRootUri();
        this.engineRoots.set(key, root.fsPath);
        const stamp = ++this.renderGeneration;
        html = await this.buildHtml(panel.webview, this.rememberedView(key), root, stamp);
        this.renderStamps.set(key, stamp);
        void this.releaseUnusedEngines();
      } catch (err) {
        // A blank editor explains nothing: show why, and report it (which,
        // for a downloaded pdf.js, offers switching back to the built-in one).
        const reason = messageOf(err);
        this.openFailures.set(key, reason);
        panel.webview.html = errorPage(`PDF Phoenix could not show this PDF: ${reason}`);
        void this.reportOpenFailure(document, reason);
        return;
      }
      panel.webview.html = html;
    };
    this.renders.set(key, render);
    await render();

    const watchPattern = new vscode.RelativePattern(
      vscode.Uri.joinPath(document.uri, ".."),
      path.basename(document.uri.fsPath)
    );
    const watcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    watcher.onDidChange(() => {
      // saveCustomDocument's own write to this same file would otherwise
      // trigger a full webview reload right as (or just after) it replies
      // to a pending byte request, racing the save/backup/dirty-tracking
      // machinery. The webview already has the bytes it just reported.
      if (Date.now() < (this.ownWriteUntil.get(key) ?? 0)) {
        return;
      }
      // Reloading would silently throw away unsaved annotations. Keep them
      // and let the user choose; saving later overwrites the file on disk,
      // the same as a text editor in that situation.
      void (async () => {
        if (await this.hasUnsavedEdits(key)) {
          if (!this.externalChangeWarned.has(key)) {
            this.externalChangeWarned.add(key);
            void this.warnExternalChange(document);
          }
          return;
        }
        await render();
      })().catch(async (err) => {
        await vscode.window.showErrorMessage(
          `PDF Phoenix could not reload ${path.basename(document.uri.fsPath)}: ${messageOf(err)}`
        );
      });
    });
    panel.onDidDispose(() => {
      watcher.dispose();
      if (this.panels.get(key) === panel) {
        this.panels.delete(key);
        this.renders.delete(key);
        this.dirty.delete(key);
        this.pageColorsStale.delete(key);
        this.rebuildPending.delete(key);
        this.renderCounts.delete(key);
        this.openFailures.delete(key);
        this.engineRoots.delete(key);
        this.renderStamps.delete(key);
        void this.releaseUnusedEngines();
        this.externalChangeWarned.delete(key);
      }
      if (this.activeKey === key) {
        this.activeKey = undefined;
      }
      this.rejectPendingFor(key, "the PDF editor was closed before it could respond.");
    });
  }

  // Ask the viewer for something and wait for its answer. The viewer may
  // still be loading the document; it answers once it has.
  private request<T>(key: string, action: string, timeoutMs: number, payload?: unknown): Promise<T> {
    const panel = this.panels.get(key);
    if (!panel) {
      return Promise.reject(new Error("no open editor for this PDF."));
    }
    const requestId = `req-${this.nextRequestId++}`;
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        reject(new Error("timed out waiting for the PDF viewer to respond."));
      }, timeoutMs);
      this.pendingReplies.set(requestId, { resolve, reject, timeout, docKey: key });
    });
    postRequest(panel, { type: "pdfphoenix-request", requestId, action, payload }, (err) => {
      const pending = this.pendingReplies.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingReplies.delete(requestId);
        pending.reject(err);
      }
    });
    return promise;
  }

  // The PDF a command acts on: the one it was given (from the Explorer,
  // opened first if needed) or the active PDF tab.
  private async commandTarget(
    uri: vscode.Uri | undefined,
    purpose: string
  ): Promise<{ key: string; target: vscode.Uri; name: string } | undefined> {
    const key = uri?.toString() ?? this.activeKey;
    if (!key) {
      void vscode.window.showInformationMessage(`Open a PDF in PDF Phoenix to ${purpose}.`);
      return undefined;
    }
    const target = vscode.Uri.parse(key);
    if (!this.panels.has(key)) {
      await vscode.commands.executeCommand("vscode.openWith", target, "pdfPhoenix.viewer");
    }
    return { key, target, name: path.basename(target.fsPath) };
  }

  // "Export Annotations to Markdown": list the PDF's annotations, including
  // unsaved ones, in a new untitled Markdown document the user can save
  // wherever they like.
  async exportAnnotations(uri?: vscode.Uri): Promise<void> {
    const resolved = await this.commandTarget(uri, "export its annotations");
    if (!resolved) {
      return;
    }
    const { key, name } = resolved;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `PDF Phoenix: collecting annotations in ${name}…` },
        () => this.request<{ pages: ExportedPage[] }>(key as string, "exportAnnotations", 120_000)
      );
      if (countAnnotations(result.pages) === 0) {
        void vscode.window.showInformationMessage(`${name} has no annotations to export.`);
        return;
      }
      const markdown = annotationsToMarkdown(name, result.pages, new Date());
      const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      // Not awaited, like the other messages here: the command is over
      // whether or not the user dismisses it.
      void vscode.window.showErrorMessage(`PDF Phoenix could not export the annotations in ${name}: ${messageOf(err)}`);
    }
  }

  // "Export Annotations as XFDF": the PDF's annotations in the standard
  // exchange format other PDF tools (Acrobat, Foxit, PDF-XChange...) import,
  // so they can travel without the PDF itself.
  async exportAnnotationsXfdf(
    uri?: vscode.Uri,
    destination?: vscode.Uri
  ): Promise<{ written: number; file: vscode.Uri } | undefined> {
    const resolved = await this.commandTarget(uri, "export its annotations");
    if (!resolved) {
      return undefined;
    }
    const { key, target, name } = resolved;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `PDF Phoenix: collecting annotations in ${name}…` },
        () =>
          this.request<{ pages: ExportedPage[]; ids: { original?: string; modified?: string } }>(
            key,
            "exportAnnotations",
            120_000
          )
      );
      if (countAnnotations(result.pages) === 0) {
        void vscode.window.showInformationMessage(`${name} has no annotations to export.`);
        return undefined;
      }
      const xfdf = annotationsToXfdf(name, result.ids ?? {}, result.pages);
      const file =
        destination ??
        (await vscode.window.showSaveDialog({
          title: `Export the annotations in ${name} as XFDF`,
          defaultUri: target.with({ path: target.path.replace(/\.pdf$/i, "") + ".xfdf" }),
          filters: { "XFDF annotations": ["xfdf"] },
        }));
      if (!file) {
        return undefined;
      }
      await vscode.workspace.fs.writeFile(file, Buffer.from(xfdf.xml, "utf8"));
      const left = describeTypeCounts(xfdf.skipped);
      void vscode.window.showInformationMessage(
        `Exported ${xfdf.written} annotation${xfdf.written === 1 ? "" : "s"} from ${name} to ${path.basename(file.fsPath)}.` +
          (left ? ` Left out: ${left} (XFDF can't carry their images or attachments).` : "")
      );
      return { written: xfdf.written, file };
    } catch (err) {
      void vscode.window.showErrorMessage(`PDF Phoenix could not export the annotations in ${name}: ${messageOf(err)}`);
      return undefined;
    }
  }

  // "Import Annotations from XFDF": add the annotations in an XFDF file to
  // the PDF as unsaved edits, which the user reviews and then saves (or
  // undoes, or reverts) like any other.
  async importAnnotations(
    uri?: vscode.Uri,
    source?: vscode.Uri,
    options?: { ignoreDocumentId?: boolean }
  ): Promise<{ imported: number; skipped: Record<string, number>; outsideDocument: number } | undefined> {
    const resolved = await this.commandTarget(uri, "import annotations into it");
    if (!resolved) {
      return undefined;
    }
    const { key, target, name } = resolved;
    const file =
      source ??
      (
        await vscode.window.showOpenDialog({
          title: `Import annotations into ${name}`,
          defaultUri: vscode.Uri.joinPath(target, ".."),
          canSelectMany: false,
          filters: { "XFDF annotations": ["xfdf", "xml"] },
        })
      )?.[0];
    if (!file) {
      return undefined;
    }
    const fileName = path.basename(file.fsPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      if (bytes.length > 50 * 1024 * 1024) {
        throw new Error(`${fileName} is larger than 50 MB, which is far more than annotations need`);
      }
      const xml = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
      type ImportResult = {
        imported: number;
        skipped: Record<string, number>;
        outsideDocument: number;
        differentDocument?: boolean;
        href?: string | null;
      };
      const run = (ignoreDocumentId: boolean) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `PDF Phoenix: importing annotations into ${name}…` },
          () => this.request<ImportResult>(key, "importXfdf", 120_000, { xml, ignoreDocumentId })
        );
      let result = await run(options?.ignoreDocumentId === true);
      if (result.differentDocument) {
        if (options?.ignoreDocumentId === false) {
          throw new Error(`${fileName} was made for a different PDF${result.href ? ` (${result.href})` : ""}`);
        }
        const go = await vscode.window.showWarningMessage(
          `${fileName} was made for a different PDF${result.href ? ` (${result.href})` : ""}. ` +
            `Its annotations may land in the wrong places in ${name}. Import them anyway?`,
          { modal: true },
          "Import Anyway"
        );
        if (go !== "Import Anyway") {
          return undefined;
        }
        result = await run(true);
      }
      const notImported = describeTypeCounts(result.skipped);
      const parts = [
        result.imported
          ? `Imported ${result.imported} annotation${result.imported === 1 ? "" : "s"} into ${name}. ` +
            `They're unsaved: review them, then save to keep them (or undo).`
          : `No annotations from ${fileName} could be imported into ${name}.`,
      ];
      if (notImported) {
        parts.push(`Not imported: ${notImported} (PDF Phoenix can create highlights, drawings and text boxes only).`);
      }
      if (result.outsideDocument) {
        parts.push(`${result.outsideDocument} referred to pages ${name} doesn't have.`);
      }
      const message = parts.join(" ");
      if (result.imported) {
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
      return { imported: result.imported, skipped: result.skipped, outsideDocument: result.outsideDocument };
    } catch (err) {
      void vscode.window.showErrorMessage(`PDF Phoenix could not import ${fileName} into ${name}: ${messageOf(err)}`);
      return undefined;
    }
  }

  // The viewer couldn't start pdf.js or open the document. pdf.js shows its
  // own message for a damaged PDF; this also covers an engine that can't run
  // in this VS Code (for example a downloaded pdf.js that needs a newer
  // Chromium), where the viewer would otherwise just stay blank.
  private async reportOpenFailure(document: vscode.CustomDocument, reason: string): Promise<void> {
    const name = path.basename(document.uri.fsPath);
    const engine = await this.pdfjs.activeInfo();
    if (engine.source === "downloaded") {
      const useBuiltIn = "Use Built-in pdf.js";
      const choice = await vscode.window.showErrorMessage(
        `PDF Phoenix could not open ${name} with pdf.js ${engine.version ?? ""}: ${reason}`,
        useBuiltIn
      );
      if (choice === useBuiltIn) {
        await this.pdfjs.resetToBundled();
      }
      return;
    }
    await vscode.window.showErrorMessage(`PDF Phoenix could not open ${name}: ${reason}`);
  }

  private async warnExternalChange(document: vscode.CustomDocument): Promise<void> {
    const reload = "Reload from Disk";
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(document.uri.fsPath)} changed on disk, but it also has unsaved changes in PDF Phoenix. ` +
        `Saving will overwrite the file on disk with your version.`,
      reload,
      "Keep My Changes"
    );
    if (choice === reload) {
      // Show the user exactly the PDF that's on disk, dropping their edits.
      await vscode.commands.executeCommand("vscode.openWith", document.uri, "pdfPhoenix.viewer");
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }

  async saveCustomDocument(document: vscode.CustomDocument): Promise<void> {
    const bytes = await this.requestBytes(document);
    const key = document.uri.toString();
    // From the start of the write until a little after it ends, however long
    // the write takes (a large PDF on a slow or network drive).
    this.ownWriteUntil.set(key, Infinity);
    try {
      if (this.saveDelayForTests) {
        await new Promise((resolve) => setTimeout(resolve, this.saveDelayForTests));
      }
      await vscode.workspace.fs.writeFile(document.uri, bytes);
    } finally {
      this.ownWriteUntil.set(key, Date.now() + OWN_WRITE_SUPPRESS_MS);
    }
    if (document instanceof PdfPhoenixDocument) {
      document.restoreFrom = undefined;
    }
    this.dirty.delete(key);
    this.externalChangeWarned.delete(key);
    await this.rerenderIfStale(key);
  }

  async saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri): Promise<void> {
    const bytes = await this.requestBytes(document);
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(document: vscode.CustomDocument): Promise<void> {
    const key = document.uri.toString();
    const panel = this.panels.get(key);
    if (!panel) {
      return;
    }
    this.dirty.delete(key);
    this.externalChangeWarned.delete(key);
    // Reverting means the file on disk, not a restored backup.
    if (document instanceof PdfPhoenixDocument) {
      document.restoreFrom = undefined;
    }
    if (this.isStale(key)) {
      // A fresh viewer reads the file from disk itself, so this is a revert too.
      await this.rerenderIfStale(key, { checkEdits: false });
      return;
    }
    await this.postDocument(panel, document);
  }

  // Send the PDF's bytes on disk to the viewer. Since VS Code 1.57 typed arrays
  // cross the webview boundary as binary rather than being serialized, so the
  // file goes as-is in both directions (see pdfphoenix-bytes) instead of as
  // base64 text a third larger. Copied into a standalone Uint8Array because
  // readFile can return a Buffer that is a view into a larger shared pool.
  private async postDocument(panel: vscode.WebviewPanel, document: vscode.CustomDocument): Promise<void> {
    const restoreFrom = document instanceof PdfPhoenixDocument ? document.restoreFrom : undefined;
    const bytes = await vscode.workspace.fs.readFile(restoreFrom ?? document.uri);
    if (restoreFrom) {
      // A restored backup holds unsaved changes: VS Code shows the document
      // as dirty, and PDF Phoenix must treat it so too (no reloads that
      // would replace it with the file on disk).
      this.dirty.add(document.uri.toString());
    }
    await panel.webview.postMessage({
      type: "pdfphoenix-load",
      data: new Uint8Array(bytes),
      filename: path.basename(document.uri.fsPath),
    });
  }

  async backupCustomDocument(
    document: vscode.CustomDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    const bytes = await this.requestBytes(document);
    await vscode.workspace.fs.writeFile(context.destination, bytes);
    const key = document.uri.toString();
    this.backupCounts.set(key, (this.backupCounts.get(key) ?? 0) + 1);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Already gone; nothing to clean up.
        }
      },
    };
  }

  // pdf.js keeps edits in an in-memory AnnotationStorage inside the
  // webview; the only way to get the merged-in-annotations bytes is to ask
  // the webview to call pdfDocument.saveDocument() and post the result
  // back. The timeout guards against a closed/frozen webview leaving a
  // save or backup hanging forever.
  private requestBytes(document: vscode.CustomDocument): Promise<Uint8Array> {
    const panel = this.panels.get(document.uri.toString());
    if (!panel) {
      return Promise.reject(new Error("PDF Phoenix: no open editor to read changes from."));
    }
    const docKey = document.uri.toString();
    const requestId = String(this.nextRequestId++);
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingByteRequests.delete(requestId);
        reject(new Error("PDF Phoenix: timed out waiting for the PDF viewer to respond."));
      }, BYTE_REQUEST_TIMEOUT_MS);
      this.pendingByteRequests.set(requestId, { resolve, reject, timeout, docKey });
    });
    postRequest(panel, { type: "pdfphoenix-get-bytes", requestId }, (err) => {
      const pending = this.pendingByteRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingByteRequests.delete(requestId);
        pending.reject(new Error(`PDF Phoenix: ${err.message}`));
      }
    });
    return promise;
  }

  // Inline pdf.js's own viewer.html as this webview's top-level document,
  // rewriting its handful of top-level asset references to webview URIs.
  //
  // Two dead ends led here:
  // - Loading it as a nested iframe navigation (pointing an <iframe src> at
  //   a remote-hosted asWebviewUri) hit a webview/Remote-WSL limitation
  //   where the navigation fell through to a real DNS lookup for the
  //   synthetic webview host and failed with ERR_NAME_NOT_RESOLVED.
  //   Sub-resource fetches (scripts, styles) from an already-loaded
  //   top-level document don't hit that.
  // - Passing the PDF via a `?file=` URL (either on the page or via
  //   AppOptions.defaultUrl) hits pdf.js's own validateFileURL() guard,
  //   which rejects it because window.location's origin (the webview
  //   shell) never matches the file's asWebviewUri origin (the resource
  //   host); those are different origin namespaces by design in VS Code.
  //   PDFViewerApplication.open() itself skips that check, so the PDF's
  //   bytes are read here and handed to the webview via postMessage once
  //   media/init.js signals it's ready.
  private async buildHtml(
    webview: vscode.Webview,
    rememberedView: ViewState | undefined,
    pdfjsRoot: vscode.Uri,
    renderStamp: number
  ): Promise<string> {
    // Resolved fresh each render so a PDF opened after an update/reset picks up
    // the new root without needing a window reload.
    const webDir = vscode.Uri.joinPath(pdfjsRoot, "web");
    const buildDir = vscode.Uri.joinPath(pdfjsRoot, "build");

    const viewerHtmlBytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(webDir, "viewer.html")
    );
    let html = Buffer.from(viewerHtmlBytes).toString("utf8");

    const initJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "init.js"));
    const overridesCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "overrides.css")
    );
    const pdfMjsUri = webview.asWebviewUri(vscode.Uri.joinPath(buildDir, "pdf.mjs"));
    const viewerCssUri = webview.asWebviewUri(vscode.Uri.joinPath(webDir, "viewer.css"));
    const viewerMjsUri = webview.asWebviewUri(vscode.Uri.joinPath(webDir, "viewer.mjs"));
    const localeJsonUri = webview.asWebviewUri(vscode.Uri.joinPath(webDir, "locale", "locale.json"));

    // pdf.js resolves its side-assets from AppOptions URLs that default to paths
    // relative to the viewer ("../web/cmaps/", "../web/wasm/", …). In a webview
    // those resolve against the shell document's origin rather than the resource
    // host, so they 404 whenever a PDF actually needs them. Hand pdf.js the real
    // webview URIs instead (init.js applies these before the document opens).
    // The directory URLs keep a trailing slash because pdf.js concatenates the
    // asset filename straight onto them.
    const cMapUri = dirUri(webview, webDir, "cmaps");
    const standardFontsUri = dirUri(webview, webDir, "standard_fonts");
    const wasmUri = dirUri(webview, webDir, "wasm");
    const iccUri = dirUri(webview, webDir, "iccs");
    const sandboxUri = webview.asWebviewUri(vscode.Uri.joinPath(buildDir, "pdf.sandbox.mjs"));
    // Without this pdf.js resolves its Web Worker against the webview shell
    // too, fails to start it, and silently parses every PDF on the page's own
    // thread ("fake worker"), freezing the UI on large documents.
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(buildDir, "pdf.worker.mjs"));

    // pdf.js's viewer.html carries its own Content-Security-Policy meta tag with
    // script-src/style-src locked to 'self'. In a webview 'self' is the shell
    // document's origin, not the resource host that actually serves our files -
    // so that policy blocks every script and stylesheet the extension points at
    // (pdf.mjs, viewer.mjs, viewer.css, init.js, overrides.css) and nothing
    // renders. The webview can serve resources from more than one host (the
    // extension dir and global storage live on different vscode-resource
    // authorities), and webview.cspSource expands to exactly that set, so the
    // policy has to be rebuilt around it rather than left at 'self'. Everything
    // pdf.js loads at runtime - cMaps, fonts, the wasm decoders, ICC profiles,
    // the scripting sandbox - is a webview URI too, hence cspSource across the
    // fetch/worker/img/font directives as well.
    const csp =
      `default-src 'none'; ` +
      `script-src ${webview.cspSource} 'wasm-unsafe-eval'; ` +
      `worker-src ${webview.cspSource} blob:; ` +
      `style-src ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} blob: data:; ` +
      `media-src blob:; ` +
      `font-src ${webview.cspSource} data:; ` +
      `connect-src ${webview.cspSource} blob: data:; ` +
      `base-uri 'none'; form-action 'none';`;
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
    const cspTagPattern = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i;
    // Swap pdf.js's own policy for ours; if a future pdf.js ever ships without
    // one, inject ours into <head> rather than leave the webview policy-less.
    html = cspTagPattern.test(html)
      ? html.replace(cspTagPattern, cspMeta)
      : html.replace(/<head>/i, `<head>\n    ${cspMeta}`);

    const { zoom, sidebar, scrollMode, spreadMode, cursorTool, viewerTheme, pageColors } = this.readViewerDefaults();
    const annotations = this.readAnnotationDefaults();
    // In Restricted Mode, JavaScript embedded in the PDF (form calculations,
    // validation, open actions) doesn't run. pdf.js sandboxes it, but an
    // untrusted workspace is exactly where the extra layer is worth having.
    const scripting = this.trustedForTests || vscode.workspace.isTrusted ? "on" : "off";
    // pdf.js would otherwise take its UI language from the webview's
    // navigator.language (Electron's locale), which can differ from the
    // language VS Code itself is displayed in. Checked against the shape of
    // a language tag so it can't break out of the attribute.
    // (The integration tests can't switch VS Code's own language without a
    // restart, so in test mode they supply one through the environment.)
    const language = (this.testMode && process.env.PDFPHOENIX_TEST_LANGUAGE) || vscode.env.language;
    const locale = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language) ? language : "en-US";

    // replaceAnchor throws when a pdf.js's viewer.html lacks one of these:
    // without them PDF Phoenix's script would never load (see pdfjs.ts).
    html = replaceAnchor(html, VIEWER_HTML_ANCHORS.locale, `href="${localeJsonUri}"`);
    html = replaceAnchor(html, VIEWER_HTML_ANCHORS.pdfMjs, `src="${pdfMjsUri}"`);
    html = replaceAnchor(
      html,
      VIEWER_HTML_ANCHORS.viewerCss,
      `href="${viewerCssUri}" />\n    <link rel="stylesheet" href="${overridesCssUri}"`
    );
    html = replaceAnchor(
      html,
      VIEWER_HTML_ANCHORS.viewerMjs,
        `<script src="${initJsUri}" data-pdfphoenix-zoom="${zoom}" data-pdfphoenix-sidebar="${sidebar}"` +
          ` data-pdfphoenix-scroll-mode="${scrollMode}" data-pdfphoenix-spread-mode="${spreadMode}"` +
          ` data-pdfphoenix-cursor-tool="${cursorTool}"` +
          ` data-pdfphoenix-highlight-color="${annotations.highlightColor}"` +
          ` data-pdfphoenix-ink-color="${annotations.inkColor}" data-pdfphoenix-ink-thickness="${annotations.inkThickness}"` +
          ` data-pdfphoenix-text-color="${annotations.textColor}" data-pdfphoenix-text-size="${annotations.textSize}"` +
          ` data-pdfphoenix-viewer-theme="${viewerTheme}" data-pdfphoenix-page-colors="${pageColors}"` +
          ` data-pdfphoenix-scripting="${scripting}" data-pdfphoenix-locale="${locale}"` +
          (rememberedView ? ` data-pdfphoenix-view="${escapeAttribute(JSON.stringify(rememberedView))}"` : "") +
          // VS Code ignores assigning a webview the HTML it already has, but
          // a reload is often needed with identical settings: the theme
          // changed (the theme isn't part of the HTML) or the file changed
          // on disk. A per-render stamp keeps each render distinct.
          ` data-pdfphoenix-render="${renderStamp}"` +
          (this.testMode ? ` data-pdfphoenix-test="1"` : "") +
          ` data-pdfphoenix-cmap-url="${cMapUri}" data-pdfphoenix-standard-fonts-url="${standardFontsUri}"` +
          ` data-pdfphoenix-wasm-url="${wasmUri}" data-pdfphoenix-icc-url="${iccUri}"` +
          ` data-pdfphoenix-sandbox-src="${sandboxUri}" data-pdfphoenix-worker-src="${workerUri}"></script>\n  <script src="${viewerMjsUri}" type="module"></script>`
    );

    return html;
  }

  // The annotation tools' starting color/size, validated the same way as
  // readViewerDefaults (a hex color, a palette name, or a clamped integer).
  private readAnnotationDefaults(): {
    highlightColor: string;
    inkColor: string;
    inkThickness: number;
    textColor: string;
    textSize: number;
  } {
    const cfg = vscode.workspace.getConfiguration("pdfPhoenix.annotations");
    const hex = (key: string): string => {
      const value = cfg.get<string>(key, "#000000");
      return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
    };
    const int = (key: string, min: number, max: number, fallback: number): number => {
      const value = Number(cfg.get<number>(key, fallback));
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const highlight = cfg.get<string>("highlightColor", "yellow");
    return {
      highlightColor: ["yellow", "green", "blue", "pink", "red"].includes(highlight) ? highlight : "yellow",
      inkColor: hex("inkColor"),
      inkThickness: int("inkThickness", 1, 20, 1),
      textColor: hex("textColor"),
      textSize: int("textSize", 5, 100, 10),
    };
  }

  // How a PDF opens, from user settings. Each is validated against its
  // allowed set so a hand-edited settings.json can't inject arbitrary text
  // into the script tag (and a bad value just falls back to the default).
  private readViewerDefaults(): {
    zoom: string;
    sidebar: string;
    scrollMode: string;
    spreadMode: string;
    cursorTool: string;
    viewerTheme: string;
    pageColors: string;
  } {
    const cfg = vscode.workspace.getConfiguration("pdfPhoenix");
    const pick = (key: string, allowed: string[], fallback: string): string => {
      const value = cfg.get<string>(key, fallback);
      return allowed.includes(value) ? value : fallback;
    };
    return {
      zoom: pick("defaultZoom", ["auto", "page-fit", "page-width", "page-actual"], "page-fit"),
      sidebar: pick("defaultSidebar", ["none", "thumbnails", "outline"], "outline"),
      scrollMode: pick("defaultScrollMode", ["document", "vertical", "horizontal", "wrapped", "page"], "document"),
      spreadMode: pick("defaultSpreadMode", ["document", "none", "odd", "even"], "document"),
      cursorTool: pick("defaultCursorTool", ["select", "hand"], "select"),
      viewerTheme: pick("viewerTheme", ["match-vscode", "light", "dark"], "match-vscode"),
      pageColors: pick("pageColors", ["original", "match-dark-themes", "match-all-themes"], "original"),
    };
  }

}
