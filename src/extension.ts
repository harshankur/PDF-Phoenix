import * as path from "node:path";
import * as vscode from "vscode";
import { PdfjsManager } from "./pdfjsManager";

export function activate(context: vscode.ExtensionContext): void {
  const manager = new PdfjsManager(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "pdfPhoenix.viewer",
      new PdfViewerProvider(context.extensionUri, manager),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.checkForUpdate", () =>
      manager.commandCheckForUpdate()
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.selectVersion", () =>
      manager.commandSelectVersion()
    ),
    vscode.commands.registerCommand("pdfPhoenix.pdfjs.resetToBundled", async () => {
      await manager.resetToBundled();
      await vscode.window.showInformationMessage(
        "PDF Phoenix is back to its built-in pdf.js. Already-open PDFs keep the previous version until you close and reopen them."
      );
    })
  );

  // Fire-and-forget: throttled internally, never blocks activation.
  void manager.maybeAutoCheck();
}

export function deactivate(): void {
  // Nothing to clean up.
}

interface PendingByteRequest {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const BYTE_REQUEST_TIMEOUT_MS = 10_000;

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
  private readonly pendingByteRequests = new Map<string, PendingByteRequest>();
  private readonly suppressNextChange = new Set<string>();
  private nextRequestId = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pdfjs: PdfjsManager
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const key = document.uri.toString();
    this.panels.set(key, panel);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.pdfjs.localResourceRoots(),
    };

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "pdfphoenix-ready": {
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          panel.webview.postMessage({
            type: "pdfphoenix-load",
            data: Buffer.from(bytes).toString("base64"),
            filename: path.basename(document.uri.fsPath),
          });
          break;
        }
        case "pdfphoenix-dirty": {
          this.changeEmitter.fire({ document });
          break;
        }
        case "pdfphoenix-bytes": {
          const pending = this.pendingByteRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingByteRequests.delete(message.requestId);
            pending.resolve(Buffer.from(message.data, "base64"));
          }
          break;
        }
      }
    });

    const render = async () => {
      panel.webview.html = await this.buildHtml(panel.webview);
    };
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
      if (this.suppressNextChange.delete(key)) {
        return;
      }
      render();
    });
    panel.onDidDispose(() => {
      watcher.dispose();
      if (this.panels.get(key) === panel) {
        this.panels.delete(key);
      }
    });
  }

  async saveCustomDocument(document: vscode.CustomDocument): Promise<void> {
    const bytes = await this.requestBytes(document);
    this.suppressNextChange.add(document.uri.toString());
    await vscode.workspace.fs.writeFile(document.uri, bytes);
  }

  async saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri): Promise<void> {
    const bytes = await this.requestBytes(document);
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(document: vscode.CustomDocument): Promise<void> {
    const panel = this.panels.get(document.uri.toString());
    if (!panel) {
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    panel.webview.postMessage({
      type: "pdfphoenix-load",
      data: Buffer.from(bytes).toString("base64"),
      filename: path.basename(document.uri.fsPath),
    });
  }

  async backupCustomDocument(
    document: vscode.CustomDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    const bytes = await this.requestBytes(document);
    await vscode.workspace.fs.writeFile(context.destination, bytes);
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
    const requestId = String(this.nextRequestId++);
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingByteRequests.delete(requestId);
        reject(new Error("PDF Phoenix: timed out waiting for the PDF viewer to respond."));
      }, BYTE_REQUEST_TIMEOUT_MS);
      this.pendingByteRequests.set(requestId, { resolve, reject, timeout });
    });
    panel.webview.postMessage({ type: "pdfphoenix-get-bytes", requestId });
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
  private async buildHtml(webview: vscode.Webview): Promise<string> {
    // Resolved fresh each render so a PDF opened after an update/reset picks up
    // the new root without needing a window reload.
    const pdfjsRoot = await this.pdfjs.activeRootUri();
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

    const { zoom, sidebar } = this.readViewerDefaults();

    html = html
      .replace('href="locale/locale.json"', `href="${localeJsonUri}"`)
      .replace('src="../build/pdf.mjs"', `src="${pdfMjsUri}"`)
      .replace(
        'href="viewer.css"',
        `href="${viewerCssUri}" />\n    <link rel="stylesheet" href="${overridesCssUri}"`
      )
      .replace(
        '<script src="viewer.mjs" type="module"></script>',
        `<script src="${initJsUri}" data-pdfphoenix-zoom="${zoom}" data-pdfphoenix-sidebar="${sidebar}"></script>\n  <script src="${viewerMjsUri}" type="module"></script>`
      );

    return html;
  }

  // The zoom/sidebar a PDF opens with, from user settings. Validated against
  // the allowed sets so a hand-edited settings.json can't inject arbitrary
  // text into the script tag (and so a bad value just falls back to default).
  private readViewerDefaults(): { zoom: string; sidebar: string } {
    const cfg = vscode.workspace.getConfiguration("pdfPhoenix");
    const zoom = cfg.get<string>("defaultZoom", "page-fit");
    const sidebar = cfg.get<string>("defaultSidebar", "outline");
    const allowedZoom = ["auto", "page-fit", "page-width", "page-actual"];
    const allowedSidebar = ["none", "thumbnails", "outline"];
    return {
      zoom: allowedZoom.includes(zoom) ? zoom : "page-fit",
      sidebar: allowedSidebar.includes(sidebar) ? sidebar : "outline",
    };
  }
}
