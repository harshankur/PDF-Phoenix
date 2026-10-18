(function () {
  var vscodeApi = acquireVsCodeApi();

  // The extension host passes the user's default-zoom / default-sidebar
  // settings as data-* attributes on this script tag. Captured here because
  // document.currentScript is only valid while this script first runs, not
  // later inside the event handler that reads them. Attributes (unlike an
  // inline <script>) aren't blocked by viewer.html's Content-Security-Policy.
  var settingsEl = document.currentScript;

  // Integration-test hooks (see runTestAction below). The extension host only
  // sets this attribute when VS Code runs the extension's own test suite.
  var testMode = !!settingsEl && settingsEl.getAttribute("data-pdfphoenix-test") === "1";
  var testLogEntries = [];
  function testLog(entry) {
    if (testMode) {
      testLogEntries.push(Date.now() % 100000 + " " + entry);
    }
  }
  if (testMode) {
    // Surface script errors (for example pdf.js failing to load on an older
    // VS Code) in the test snapshot.
    window.addEventListener("error", function (event) {
      testLog("error " + (event.message || (event.target && event.target.src) || "unknown"));
    });
    window.addEventListener("unhandledrejection", function (event) {
      testLog("rejection " + (event.reason && event.reason.message ? event.reason.message : String(event.reason)));
    });
  }

  var SIDEBAR_VIEW = { none: 0, thumbnails: 1, outline: 2 };
  // pdf.js's ScrollMode / SpreadMode / CursorTool values. "document" (not
  // listed) leaves the choice to the PDF's own page layout preference.
  var SCROLL_MODE = { vertical: 0, horizontal: 1, wrapped: 2, page: 3 };
  var SPREAD_MODE = { none: 0, odd: 1, even: 2 };
  var CURSOR_TOOL = { select: 0, hand: 1 };
  var ALLOWED_ZOOM = { auto: 1, "page-fit": 1, "page-width": 1, "page-actual": 1 };

  // Copy a webview-URI value from the script tag's data-* attribute into the
  // matching pdf.js AppOption. Absent/empty attributes leave the default alone.
  // pdf.js's AnnotationEditorParamsType values for the tool defaults below.
  var EDITOR_PARAM = { TEXT_SIZE: 11, TEXT_COLOR: 12, INK_COLOR: 21, INK_THICKNESS: 22, HIGHLIGHT_COLOR: 31 };
  var annotationDefaultsApplied = false;

  // Give the annotation tools the user's starting colors and sizes. These
  // go through the same event pdf.js's own toolbar uses, which with no
  // annotation selected sets the defaults for new ones. The editor types are
  // only registered once the first page's editor layer exists, so this waits
  // for that, and only runs once per viewer so a revert doesn't undo choices
  // the user has since made in the toolbar.
  function applyAnnotationDefaults(app) {
    if (annotationDefaultsApplied || !settingsEl) {
      return;
    }
    annotationDefaultsApplied = true;
    var attr = function (name) {
      return settingsEl.getAttribute("data-pdfphoenix-" + name);
    };
    var params = [];
    // The highlight setting names one of pdf.js's palette colors, so the
    // toolbar's color picker shows it as selected.
    var palette = String(window.PDFViewerApplicationOptions.get("highlightEditorColors") || "");
    var wanted = attr("highlight-color");
    palette.split(",").forEach(function (pair) {
      var parts = pair.split("=");
      if (parts.length === 2 && parts[0].trim() === wanted) {
        params.push([EDITOR_PARAM.HIGHLIGHT_COLOR, parts[1].trim().toUpperCase()]);
      }
    });
    if (attr("ink-color")) {
      params.push([EDITOR_PARAM.INK_COLOR, attr("ink-color")]);
    }
    if (attr("ink-thickness")) {
      params.push([EDITOR_PARAM.INK_THICKNESS, Number(attr("ink-thickness"))]);
    }
    if (attr("text-color")) {
      params.push([EDITOR_PARAM.TEXT_COLOR, attr("text-color")]);
    }
    if (attr("text-size")) {
      params.push([EDITOR_PARAM.TEXT_SIZE, Number(attr("text-size"))]);
    }
    params.forEach(function (param) {
      app.eventBus.dispatch("switchannotationeditorparams", { source: window, type: param[0], value: param[1] });
    });
    // pdf.js only refreshes its tool toolbar from the defaults when the
    // editor types first register, which has already happened. Send the
    // same update it would, so the toolbar shows what new annotations use.
    app.eventBus.dispatch("annotationeditorparamschanged", { source: window, details: params });
  }

  // Map a setting's name (from the script tag's data-* attribute) to the
  // pdf.js AppOption value. Unknown values leave pdf.js's default alone.
  function setModeOption(options, optionName, values, attribute) {
    var value = settingsEl ? settingsEl.getAttribute(attribute) : null;
    if (value && Object.prototype.hasOwnProperty.call(values, value)) {
      options.set(optionName, values[value]);
    }
  }

  function setAssetOption(options, optionName, attribute) {
    var value = settingsEl ? settingsEl.getAttribute(attribute) : null;
    if (value) {
      options.set(optionName, value);
    }
  }

  // pdfPhoenix.viewerTheme / pdfPhoenix.pageColors. Start from the script
  // tag; the extension host posts "pdfphoenix-theme-settings" when either
  // setting changes while this PDF is open.
  var viewerThemeSetting = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-viewer-theme") : null;
  var pageColorsSetting = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-page-colors") : null;

  // VS Code marks the webview's <body> with its theme kind (vscode-light,
  // vscode-dark, vscode-high-contrast, vscode-high-contrast-light) and keeps
  // it current as the user switches themes. High contrast light also carries
  // vscode-high-contrast, so it is checked first. Returns null if no marker
  // is present, leaving pdf.js's own behaviour alone.
  function vscodeThemeIsDark() {
    var classes = document.body ? document.body.classList : null;
    if (!classes) {
      return null;
    }
    if (classes.contains("vscode-high-contrast-light") || classes.contains("vscode-light")) {
      return false;
    }
    if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) {
      return true;
    }
    return null;
  }

  // viewer.css themes its toolbar, sidebar and dialogs with light-dark(),
  // which follows the color-scheme property. This is the same property pdf.js
  // sets for its own viewerCssTheme option, applied here instead so it can
  // track VS Code theme changes while the PDF stays open. Only written when
  // it actually changes, since the theme observer below also watches this
  // element's style attribute.
  function applyViewerTheme() {
    var scheme = null;
    if (viewerThemeSetting === "light" || viewerThemeSetting === "dark") {
      scheme = viewerThemeSetting;
    } else {
      var dark = vscodeThemeIsDark();
      scheme = dark === null ? null : dark ? "dark" : "light";
    }
    var style = document.documentElement.style;
    if ((style.getPropertyValue("color-scheme") || null) === scheme) {
      return;
    }
    if (scheme) {
      style.setProperty("color-scheme", scheme);
    } else {
      style.removeProperty("color-scheme");
    }
  }

  // The page colors the current VS Code theme and pdfPhoenix.pageColors call
  // for: the editor's own background/text colors, or null for the document's
  // own colors. VS Code keeps these --vscode-* variables current on <html>.
  function wantedPageColors() {
    var wanted =
      pageColorsSetting === "match-all-themes" ||
      (pageColorsSetting === "match-dark-themes" && vscodeThemeIsDark() === true);
    if (!wanted) {
      return null;
    }
    var rootStyle = getComputedStyle(document.documentElement);
    var background = rootStyle.getPropertyValue("--vscode-editor-background").trim();
    var foreground = rootStyle.getPropertyValue("--vscode-editor-foreground").trim();
    return background && foreground ? { background: background, foreground: foreground } : null;
  }

  function pageColorsKey(colors) {
    return colors ? colors.background + "|" + colors.foreground : "";
  }

  // pdf.js reads its page colors once, when the viewer is built, and threads
  // them through every page, thumbnail and annotation layer, so they can't be
  // swapped in place. When the theme or setting calls for different colors,
  // tell the extension host, which reloads this tab (straight away when there
  // are no unsaved edits, otherwise after the next save or revert). The view
  // state below brings the reader back to the same place.
  var appliedPageColorsKey = null;
  var pageColorsStale = false;

  function checkPageColors() {
    if (appliedPageColorsKey === null) {
      return;
    }
    var stale = pageColorsKey(wantedPageColors()) !== appliedPageColorsKey;
    testLog("check body=" + document.body.className + " wanted=" + pageColorsKey(wantedPageColors()) + " stale=" + stale);
    if (stale !== pageColorsStale) {
      pageColorsStale = stale;
      vscodeApi.postMessage({ type: "pdfphoenix-page-colors-stale", stale: stale });
    }
  }

  function onThemeChanged() {
    applyViewerTheme();
    checkPageColors();
  }

  // Runs from the webviewerloaded handler: this script sits in viewer.html's
  // <head>, so <body> (which carries VS Code's theme classes) doesn't exist
  // yet when it first runs.
  function startThemeTracking(options) {
    var colors = wantedPageColors();
    if (options && colors) {
      // forcePageColors turns on pdf.js's high contrast page rendering
      // without needing the OS-level forced-colors mode.
      options.set("forcePageColors", true);
      options.set("pageColorsBackground", colors.background);
      options.set("pageColorsForeground", colors.foreground);
    }
    appliedPageColorsKey = options ? pageColorsKey(colors) : null;
    testLog("start body=" + document.body.className + " applied=" + appliedPageColorsKey);
    applyViewerTheme();
    if (window.MutationObserver) {
      var observer = new MutationObserver(onThemeChanged);
      // Theme kind changes show up as <body> classes; switching between two
      // themes of the same kind only changes the --vscode-* variables in
      // <html>'s inline style.
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    }
  }

  // Where the reader is in the document (page, zoom and scroll position,
  // rotation, sidebar panel, scroll/spread mode), kept in the webview's own
  // state. That survives the extension host re-rendering this same tab - for
  // new page colors above, or when the file changes on disk - so the reload
  // reopens at the same place instead of the first page. A newly opened tab
  // starts with no state and opens with the user's defaults as before.
  // A reload of this same tab restores from the webview's own state; a newly
  // opened tab starts from where the PDF was last left, which the extension
  // host passes in (pdfPhoenix.rememberViewState), or the defaults if none.
  var restoreView = (vscodeApi.getState() || {}).view || rememberedViewFromHost();
  var currentView = {};
  var viewTracked = false;

  function rememberedViewFromHost() {
    var raw = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-view") : null;
    if (!raw) {
      return null;
    }
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  // Scrolling reports a new place many times a second, so the host (which
  // persists it across tabs) hears about it at most every 250ms.
  var viewReportTimer = null;
  function reportViewToHost() {
    if (viewReportTimer === null) {
      viewReportTimer = setTimeout(function () {
        viewReportTimer = null;
        vscodeApi.postMessage({ type: "pdfphoenix-view-state", view: currentView });
      }, 250);
    }
  }

  function rememberView(changes) {
    for (var name in changes) {
      currentView[name] = changes[name];
    }
    vscodeApi.setState({ view: currentView });
    reportViewToHost();
  }

  // These are the same eventBus events pdf.js's own view history records.
  // Changes made while pdf.js is still applying the initial view are ignored,
  // as pdf.js does, so they can't overwrite the place being restored.
  function trackView(app) {
    if (viewTracked || !app.eventBus) {
      return;
    }
    viewTracked = true;
    app.eventBus.on("annotationeditorlayerrendered", function () {
      applyAnnotationDefaults(app);
    });
    app.eventBus.on("annotationeditoruimanager", function (evt) {
      editorUiManager = evt.uiManager;
    });
    app.eventBus.on("updatefromsandbox", function () {
      sandboxUpdated = true;
    });
    if (testMode) {
      ["annotationeditoruimanager", "annotationeditorlayerrendered", "annotationeditormodechanged", "pagerendered"].forEach(
        function (name) {
          app.eventBus.on(name, function (evt) {
            testLog("event " + name + (evt && evt.pageNumber ? " p" + evt.pageNumber : "") + (evt && evt.mode !== undefined ? " m" + evt.mode : ""));
          });
        }
      );
    }
    if (restoreView) {
      rememberView(restoreView);
    }
    app.eventBus.on("updateviewarea", function (evt) {
      if (app.isInitialViewSet && evt.location && evt.location.pdfOpenParams) {
        rememberView({
          hash: evt.location.pdfOpenParams.replace(/^#/, ""),
          rotation: evt.location.rotation,
        });
      }
    });
    app.eventBus.on("sidebarviewchanged", function (evt) {
      if (app.isInitialViewSet) {
        rememberView({ sidebarView: evt.view });
      }
    });
    app.eventBus.on("scrollmodechanged", function (evt) {
      if (app.isInitialViewSet) {
        rememberView({ scrollMode: evt.mode });
      }
    });
    app.eventBus.on("spreadmodechanged", function (evt) {
      if (app.isInitialViewSet) {
        rememberView({ spreadMode: evt.mode });
      }
    });
  }

  // Sidebar and scroll/spread modes are AppOptions read when the document
  // opens, so they're set in the webviewerloaded handler.
  function applyRestoredModes(options) {
    if (!restoreView) {
      return;
    }
    if (typeof restoreView.sidebarView === "number") {
      options.set("sidebarViewOnLoad", restoreView.sidebarView);
    }
    if (typeof restoreView.scrollMode === "number") {
      options.set("scrollModeOnLoad", restoreView.scrollMode);
    }
    if (typeof restoreView.spreadMode === "number") {
      options.set("spreadModeOnLoad", restoreView.spreadMode);
    }
  }

  // Page, zoom, scroll and rotation go through pdf.js's initial bookmark,
  // which its initial view applies ahead of the default zoom. Only for the
  // first open in this page; a revert reopens the document as before.
  function applyRestoredPosition(app) {
    if (!restoreView) {
      return;
    }
    if (restoreView.hash) {
      app.initialBookmark = restoreView.hash;
    }
    if (typeof restoreView.rotation === "number") {
      app.initialRotation = restoreView.rotation;
    }
    restoreView = null;
  }

  // Compare AnnotationStorage's own content hash on a timer rather than
  // reacting to onSetModified/onResetModified or trusting
  // _annotationStorageModified/.size:
  //  - .size only ever sees one 0->1 transition per document load (it
  //    never drops back to 0 just because a save happened), so it goes
  //    blind to every edit after the first save.
  //  - _annotationStorageModified/onSetModified/onResetModified only fire
  //    on the *edge* of pdf.js's own internal #modified boolean flipping.
  //    pdf.js can flip it true via a false-positive re-commit of an
  //    *unchanged* editor (e.g. switching tools while one is still
  //    selected, re-serializing rect/color into freshly-allocated but
  //    value-identical arrays). Nothing then flips it back to false until
  //    the next real save - so onSetModified silently stops firing for
  //    every genuine edit that happens afterwards, going blind exactly
  //    when it matters most. Confirmed directly against the live API:
  //    setValue(realChange) after one such false-positive never called
  //    onSetModified again despite the content genuinely differing.
  // serializable.hash is a content hash (MurmurHash3 over each entry's
  // JSON-serialized value) already computed by pdf.js for saveDocument()
  // itself. Polling it sidesteps both problems: it's stable across
  // reference-only false positives, and - unlike the callbacks - it's
  // simply read fresh every tick regardless of what pdf.js's internal flag
  // is doing.
  // tryOpen() runs again on every revert (extension.ts posts a fresh
  // "pdfphoenix-load" into the same still-open webview rather than reloading
  // the page), which would otherwise chain into a second watchForEdits() call
  // and leak the previous poll interval. Tracking it here lets each call
  // clear its predecessor first.
  var editWatchInterval = null;
  var editBaselineHash = null;

  // A PDF's own scripts (form calculations, open actions filling in fields)
  // change the annotation storage too, often right as it opens. Those
  // changes are the document's starting state, not edits: a change counts as
  // the document's own if pdf.js's script sandbox just updated it and the
  // user hasn't clicked or typed in the viewer yet. Edits PDF Phoenix makes
  // for the user (an XFDF import) are flagged as edits outright.
  var sandboxUpdated = false;
  var userInteracted = false;
  var hostEditPending = false;
  document.addEventListener("pointerdown", function () {
    userInteracted = true;
  }, true);
  document.addEventListener("keydown", function () {
    userInteracted = true;
  }, true);

  function markHostEdit() {
    hostEditPending = true;
  }

  // Report the annotation storage having changed since the last check (or
  // since the document opened). Also run on request, so the extension host
  // can make sure it knows about an edit made in the last 200ms before
  // reloading the viewer. Returns whether there was a new edit.
  function checkForEdits() {
    var app = window.PDFViewerApplication;
    var storage = app && app.pdfDocument && app.pdfDocument.annotationStorage;
    if (!storage || editBaselineHash === null) {
      return false;
    }
    var currentHash = storage.serializable.hash;
    if (currentHash === editBaselineHash) {
      return false;
    }
    editBaselineHash = currentHash;
    if (sandboxUpdated && !userInteracted && !hostEditPending) {
      sandboxUpdated = false;
      return false;
    }
    sandboxUpdated = false;
    hostEditPending = false;
    vscodeApi.postMessage({ type: "pdfphoenix-dirty" });
    return true;
  }

  function watchForEdits() {
    var app = window.PDFViewerApplication;
    if (editWatchInterval !== null) {
      clearInterval(editWatchInterval);
    }
    editBaselineHash = app.pdfDocument.annotationStorage.serializable.hash;
    sandboxUpdated = false;
    userInteracted = false;
    hostEditPending = false;
    editWatchInterval = setInterval(checkForEdits, 200);
  }

  // Tracks the in-progress app.open() so replyWithBytes() can wait for it
  // instead of assuming app.pdfDocument is already set. A save/backup
  // request landing in the brief window right after opening a PDF (before
  // app.open() resolves) would otherwise throw synchronously on
  // app.pdfDocument being undefined, leaving the extension host's request
  // hanging until its timeout instead of failing fast or succeeding.
  var documentReadyPromise = null;

  // Resolves once a document has first been opened in this viewer, for
  // requests that can arrive before then (for example exporting a PDF that
  // the Explorer command has only just opened).
  var resolveFirstOpen;
  var firstOpen = new Promise(function (resolve) {
    resolveFirstOpen = resolve;
  });

  // Tell the extension host when pdf.js can't start or open the document,
  // so the user gets an explanation (and, for a downloaded engine, a way back
  // to the built-in one) instead of a blank editor.
  var openFailureReported = false;
  function reportOpenFailure(err) {
    if (openFailureReported) {
      return;
    }
    openFailureReported = true;
    vscodeApi.postMessage({
      type: "pdfphoenix-open-failed",
      message: err && err.message ? err.message : String(err),
    });
  }

  // pdf.js's viewer.mjs dispatches webviewerloaded once it has loaded. If it
  // never does (a script error, or an engine using browser features this
  // VS Code's webview lacks), there is nothing else that would notice.
  var viewerStarted = false;
  setTimeout(function () {
    if (!viewerStarted) {
      reportOpenFailure(new Error("the pdf.js viewer did not start"));
    }
  }, 20000);

  // pdf.js parses PDFs in a Web Worker. Its default worker URL is relative
  // and resolves against the webview shell, and even the real webview URI
  // can't be used directly: it's on the resource host, a different origin,
  // and browsers only start workers from same-origin scripts. pdf.js's own
  // cross-origin fallback (a blob: that imports the module) doesn't load
  // through the webview's resource handling either. Without a worker pdf.js
  // silently parses on this page's thread instead, freezing the UI on large
  // documents. So fetch the worker's code (connect-src allows the resource
  // host) and start it from a same-origin blob: URL. Started as soon as this
  // script runs; tryOpen waits for it before opening a document.
  var workerBlobUrl = null;

  // Start a pdf.js worker from the blob and resolve once it has loaded and
  // said "ready". pdf.js waits for that itself when it starts a worker, but
  // not for a worker handed to it as a port, and messages sent before the
  // worker's module has run would be lost.
  function startWorker(url) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker(url, { type: "module" });
      var timer = setTimeout(function () {
        worker.terminate();
        reject(new Error("the pdf.js worker did not start"));
      }, 30000);
      worker.addEventListener("message", function onMessage(event) {
        if (event.data && event.data.action === "ready") {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
          resolve(worker);
        }
      });
      worker.addEventListener("error", function (event) {
        clearTimeout(timer);
        reject(new Error(event.message || "the pdf.js worker failed to load"));
      });
    });
  }

  var workerPortPromise = (function () {
    var src = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-worker-src") : null;
    if (!src || typeof Worker === "undefined") {
      return Promise.resolve(null);
    }
    return fetch(src)
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status + (testMode ? " for " + src : ""));
        }
        return response.blob();
      })
      .then(function (blob) {
        workerBlobUrl = URL.createObjectURL(new Blob([blob], { type: "text/javascript" }));
        return startWorker(workerBlobUrl);
      })
      .then(function (worker) {
        testLog("worker ready");
        return worker;
      })
      .catch(function (err) {
        testLog("worker failed " + (err && err.message ? err.message : err));
        console.warn("PDF Phoenix: could not start the pdf.js worker, parsing on the page instead:", err);
        return null;
      });
  })();

  function tryOpen(bytes, filename, startedAt) {
    startedAt = startedAt || Date.now();
    var app = window.PDFViewerApplication;
    if (app && app.initializedPromise) {
      openFailureReported = false;
      documentReadyPromise = Promise.all([app.initializedPromise, workerPortPromise])
        .then(function (results) {
          // pdf.js copies its worker options into GlobalWorkerOptions on
          // every open; with a port it uses that worker instead of loading
          // one itself (and reuses it for later documents).
          if (results[1]) {
            window.PDFViewerApplicationOptions.set("workerPort", results[1]);
          }
          testLog("open with workerPort " + !!results[1] + ", fake already " + !!window.pdfjsWorker);
        })
        .then(function () {
          trackView(app);
          applyRestoredPosition(app);
          return app.open({ data: bytes, filename: filename });
        })
        .then(function () {
          watchForEdits();
          resolveFirstOpen();
          return app;
        });
      documentReadyPromise.catch(reportOpenFailure);
    } else {
      // pdf.js hasn't set itself up yet; wait for it, but not forever.
      if (Date.now() - startedAt > 20000) {
        reportOpenFailure(new Error("the pdf.js viewer did not start"));
        return;
      }
      setTimeout(function () {
        tryOpen(bytes, filename, startedAt);
      }, 30);
    }
  }

  // ---------- annotation export ----------

  // Annotation types worth listing; links, form fields and popups are not.
  var EXPORTED_TYPES = {
    Highlight: 1, Underline: 1, StrikeOut: 1, Squiggly: 1, Text: 1, FreeText: 1, Ink: 1, Stamp: 1,
    Square: 1, Circle: 1, Line: 1, Polygon: 1, PolyLine: 1, Caret: 1, FileAttachment: 1,
  };
  // Text markup annotations, whose covered text is extracted.
  var TEXT_MARKUP = { Highlight: 1, Underline: 1, StrikeOut: 1, Squiggly: 1 };
  var measureContext = null;

  // A plain array from pdf.js's typed arrays (which don't survive the trip to
  // the extension host as lists), or undefined.
  function numbers(values) {
    return values && values.length ? Array.prototype.slice.call(values) : undefined;
  }

  function toHexColor(rgb) {
    if (!rgb || rgb.length < 3) {
      return undefined;
    }
    return (
      "#" +
      Array.prototype.slice
        .call(rgb, 0, 3)
        .map(function (v) {
          return ("0" + Math.round(v).toString(16)).slice(-2);
        })
        .join("")
        .toUpperCase()
    );
  }

  // The page text under a highlight (or other text markup), from its quad
  // regions. pdf.js reports text in runs with a position and total width but
  // no per-character positions, so each run's characters are measured in its
  // font and scaled to the run's width, and a character counts as covered
  // when its center is inside a quad that overlaps the run's line.
  function textUnderQuads(quadPoints, content) {
    if (!quadPoints || !content) {
      return undefined;
    }
    measureContext = measureContext || document.createElement("canvas").getContext("2d");
    var parts = [];
    for (var q = 0; q + 7 < quadPoints.length; q += 8) {
      var xs = [quadPoints[q], quadPoints[q + 2], quadPoints[q + 4], quadPoints[q + 6]];
      var ys = [quadPoints[q + 1], quadPoints[q + 3], quadPoints[q + 5], quadPoints[q + 7]];
      var quad = {
        x0: Math.min.apply(null, xs),
        x1: Math.max.apply(null, xs),
        y0: Math.min.apply(null, ys),
        y1: Math.max.apply(null, ys),
      };
      var line = "";
      var lastEnd = null;
      content.items.forEach(function (item) {
        if (!item.str || !item.transform) {
          return;
        }
        var x0 = item.transform[4];
        var baseline = item.transform[5];
        var height = item.height || Math.abs(item.transform[3]) || 1;
        var top = baseline + height;
        var bottom = baseline - height * 0.25;
        var overlap = Math.min(top, quad.y1) - Math.max(bottom, quad.y0);
        if (overlap < Math.min(top - bottom, quad.y1 - quad.y0) * 0.5) {
          return;
        }
        if (x0 + item.width < quad.x0 || x0 > quad.x1) {
          return;
        }
        var chars = Array.from(item.str);
        var style = content.styles[item.fontName] || {};
        measureContext.font = "100px " + (style.fontFamily || "sans-serif");
        var widths = chars.map(function (ch) {
          return measureContext.measureText(ch).width || 0;
        });
        var total = widths.reduce(function (a, b) {
          return a + b;
        }, 0);
        var x = x0;
        var picked = "";
        var pickedStart = null;
        var pickedEnd = null;
        chars.forEach(function (ch, i) {
          var w = total > 0 ? (widths[i] * item.width) / total : item.width / chars.length;
          var mid = x + w / 2;
          if (mid >= quad.x0 && mid <= quad.x1) {
            picked += ch;
            pickedStart = pickedStart === null ? x : pickedStart;
            pickedEnd = x + w;
          }
          x += w;
        });
        if (picked) {
          // Separate runs that are visibly apart with a space.
          if (lastEnd !== null && pickedStart - lastEnd > height * 0.15 && !/\s$/.test(line)) {
            line += " ";
          }
          line += picked;
          lastEnd = pickedEnd;
        }
      });
      line = line.replace(/\s+/g, " ").trim();
      if (line) {
        parts.push(line);
      }
    }
    return parts.length ? parts.join(" ") : undefined;
  }

  function collectPage(pdf, pageNumber, labels) {
    return pdf.getPage(pageNumber).then(function (page) {
      return page.getAnnotations().then(function (annotations) {
        var wanted = annotations.filter(function (a) {
          return EXPORTED_TYPES[a.subtype];
        });
        var needsText = wanted.some(function (a) {
          return TEXT_MARKUP[a.subtype] && a.quadPoints;
        });
        return (needsText ? page.getTextContent() : Promise.resolve(null)).then(function (content) {
          // Reading order: top to bottom, then left to right.
          wanted.sort(function (a, b) {
            return b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0];
          });
          return {
            pageNumber: pageNumber,
            label: labels && labels[pageNumber - 1] ? labels[pageNumber - 1] : undefined,
            annotations: wanted.map(function (a) {
              var appearance = a.defaultAppearanceData || {};
              return {
                type: a.subtype,
                text: TEXT_MARKUP[a.subtype] ? textUnderQuads(a.quadPoints, content) : undefined,
                contents: (a.contentsObj && a.contentsObj.str) || undefined,
                author: (a.titleObj && a.titleObj.str) || undefined,
                color: toHexColor(a.color),
                modified: a.modificationDate || undefined,
                // Geometry and styling for the XFDF export.
                id: a.id || undefined,
                rect: numbers(a.rect),
                quadPoints: numbers(a.quadPoints),
                inkLists: a.inkLists
                  ? Array.prototype.map.call(a.inkLists, function (stroke) {
                      return numbers(stroke);
                    })
                  : undefined,
                vertices: numbers(a.vertices),
                line: numbers(a.lineCoordinates),
                interiorColor: toHexColor(a.interiorColor),
                opacity: typeof a.opacity === "number" ? a.opacity : undefined,
                borderWidth: a.borderStyle && typeof a.borderStyle.width === "number" ? a.borderStyle.width : undefined,
                created: a.creationDate || undefined,
                icon: a.subtype === "Text" && a.name ? a.name : undefined,
                fontSize: a.subtype === "FreeText" && appearance.fontSize ? appearance.fontSize : undefined,
                fontColor: a.subtype === "FreeText" ? toHexColor(appearance.fontColor) : undefined,
                flags: a.annotationFlags || undefined,
              };
            }),
          };
        });
      });
    });
  }

  // Every annotation in the document, by page, including unsaved edits:
  // those live in pdf.js's annotation storage until saved, so the document
  // is serialized the way a save would (in memory only) and that copy read.
  function exportAnnotations() {
    return firstOpen
      .then(function () {
        return documentReadyPromise;
      })
      .then(function (app) {
        var doc = app.pdfDocument;
        var options = window.PDFViewerApplicationOptions;
        // The copy gets a worker of its own, terminated afterwards: sharing
        // the viewer's worker connection between two documents stalls
        // pdf.js's streamed text extraction.
        var copyWorker = null;
        var copyTask = null;
        var source =
          doc.annotationStorage.size > 0
            ? Promise.all([doc.saveDocument(), workerBlobUrl ? startWorker(workerBlobUrl) : null]).then(function (results) {
                var bytes = results[0];
                var lib = window.pdfjsLib;
                if (results[1]) {
                  // PDFWorker.create in current pdf.js; fromPort in older
                  // releases a user may have switched to.
                  var makeWorker = lib.PDFWorker.create || lib.PDFWorker.fromPort;
                  copyWorker = makeWorker.call(lib.PDFWorker, { port: results[1] });
                }
                copyTask = lib.getDocument({
                  worker: copyWorker || undefined,
                  data: bytes,
                  cMapUrl: options.get("cMapUrl"),
                  cMapPacked: true,
                  standardFontDataUrl: options.get("standardFontDataUrl"),
                  wasmUrl: options.get("wasmUrl"),
                  iccUrl: options.get("iccUrl"),
                  isEvalSupported: false,
                });
                return copyTask.promise;
              })
            : Promise.resolve(doc);
        // Release the copy and its worker however the export ends. (A
        // document is destroyed through its loading task in current pdf.js.)
        var cleanUp = function () {
          var port = copyWorker && copyWorker.port;
          var destroyed = copyTask ? copyTask.destroy() : Promise.resolve();
          Promise.resolve(destroyed).then(function () {
            if (port && port.terminate) {
              port.terminate();
            }
          });
        };
        return source.then(function (pdf) {
          return pdf
            .getPageLabels()
            .catch(function () {
              return null;
            })
            .then(function (labels) {
              var pages = [];
              var chain = Promise.resolve();
              for (var n = 1; n <= pdf.numPages; n++) {
                chain = chain.then(
                  collectPage.bind(null, pdf, n, labels)
                ).then(function (page) {
                  pages.push(page);
                });
              }
              return chain.then(function () {
                // pdf.js's fingerprints are the PDF's /ID (or a hash of its
                // start when it has none): XFDF's <ids> for matching later.
                var ids = doc.fingerprints || [];
                return { pages: pages, ids: { original: ids[0] || undefined, modified: ids[1] || ids[0] || undefined } };
              });
            });
        }).then(
          function (result) {
            cleanUp();
            return result;
          },
          function (err) {
            cleanUp();
            throw err;
          }
        );
      });
  }

  // ---------- annotation import (XFDF) ----------

  // pdf.js's annotation editors can create (and save) only text boxes,
  // highlights and drawings; other XFDF annotation types are reported as
  // skipped rather than silently dropped.
  var EDITOR_TYPE = { FREETEXT: 3, HIGHLIGHT: 9, INK: 15 };

  function xfdfNumbers(text) {
    return String(text || "")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number)
      .filter(function (n) {
        return isFinite(n);
      });
  }

  function xfdfColor(text, fallback) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(text || "").trim());
    if (!match) {
      return fallback;
    }
    return [0, 2, 4].map(function (i) {
      return parseInt(match[1].slice(i, i + 2), 16);
    });
  }

  function xfdfDate(text) {
    var lib = window.pdfjsLib;
    if (!text || !lib || !lib.PDFDateString) {
      return null;
    }
    return lib.PDFDateString.toDateObject(text) || null;
  }

  // XFDF files may or may not use the XFDF namespace (or a prefix), so
  // elements are matched by local name.
  function childElements(parent, name) {
    var result = [];
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].localName.toLowerCase() === name) {
        result.push(parent.children[i]);
      }
    }
    return result;
  }

  function childText(parent, name) {
    var found = childElements(parent, name)[0];
    return found ? found.textContent : "";
  }

  // A text box's font size and color from its XFDF appearance strings:
  // "/Helv 12 Tf 1 0 0 rg" (PDF operators) or "font: Helvetica 12pt;
  // color: #FF0000" (CSS-like), as different tools write them.
  function xfdfTextStyle(element) {
    var da = childText(element, "defaultappearance") || element.getAttribute("defaultappearance") || "";
    var ds = childText(element, "defaultstyle") || element.getAttribute("defaultstyle") || "";
    var size = /([\d.]+)\s+Tf/.exec(da) || /([\d.]+)\s*pt/.exec(ds);
    var color = [0, 0, 0];
    var rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    var gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
    var css = /color\s*:\s*(#[0-9a-f]{6})/i.exec(ds);
    if (rgb) {
      color = [rgb[1], rgb[2], rgb[3]].map(function (v) {
        return Math.round(Math.min(1, Number(v)) * 255);
      });
    } else if (css) {
      color = xfdfColor(css[1], color);
    } else if (gray) {
      color = [0, 0, 0].map(function () {
        return Math.round(Math.min(1, Number(gray[1])) * 255);
      });
    }
    var fontSize = size ? Number(size[1]) : 10;
    return { fontSize: fontSize > 0 && fontSize <= 200 ? fontSize : 10, color: color };
  }

  // One XFDF annotation element as the data pdf.js's editors deserialize
  // (the same shape they use for copy and paste), plus the note to attach,
  // or null when it can't become an editor.
  function xfdfToEditorData(element, pageIndex) {
    var type = element.localName.toLowerCase();
    var r = xfdfNumbers(element.getAttribute("rect"));
    if (r.length !== 4) {
      return null;
    }
    var rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    var opacity = parseFloat(element.getAttribute("opacity"));
    opacity = isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    var contents = childText(element, "contents") || childText(element, "contents-richtext");
    var data = {
      pageIndex: pageIndex,
      rect: rect,
      rotation: 0,
      creationDate: xfdfDate(element.getAttribute("creationdate")),
      modificationDate: xfdfDate(element.getAttribute("date")),
    };
    if (type === "highlight") {
      var coords = xfdfNumbers(element.getAttribute("coords"));
      if (coords.length < 8) {
        coords = [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]];
      }
      // Tools differ in the corner order they write, so each quad is
      // normalized to the order pdf.js expects: top-left, top-right,
      // bottom-left, bottom-right.
      var quads = [];
      for (var q = 0; q + 7 < coords.length; q += 8) {
        var xs = [coords[q], coords[q + 2], coords[q + 4], coords[q + 6]];
        var ys = [coords[q + 1], coords[q + 3], coords[q + 5], coords[q + 7]];
        var x0 = Math.min.apply(null, xs);
        var x1 = Math.max.apply(null, xs);
        var y0 = Math.min.apply(null, ys);
        var y1 = Math.max.apply(null, ys);
        quads.push(x0, y1, x1, y1, x0, y0, x1, y0);
      }
      data.annotationType = EDITOR_TYPE.HIGHLIGHT;
      data.color = xfdfColor(element.getAttribute("color"), [255, 255, 152]);
      data.opacity = opacity;
      data.quadPoints = new Float32Array(quads);
      return { data: data, note: contents.trim() };
    }
    if (type === "ink") {
      var strokes = [];
      childElements(element, "inklist").forEach(function (inkList) {
        childElements(inkList, "gesture").forEach(function (gesture) {
          var values = xfdfNumbers(gesture.textContent);
          if (values.length >= 2) {
            strokes.push(new Float32Array(values.slice(0, values.length - (values.length % 2))));
          }
        });
      });
      if (!strokes.length) {
        return null;
      }
      var width = parseFloat(element.getAttribute("width"));
      data.annotationType = EDITOR_TYPE.INK;
      data.color = xfdfColor(element.getAttribute("color"), [0, 0, 0]);
      data.thickness = isFinite(width) && width > 0 ? Math.min(width, 20) : 1;
      data.opacity = opacity;
      data.paths = { points: strokes };
      return { data: data, note: contents.trim() };
    }
    if (type === "freetext") {
      var text = contents.replace(/\r\n?/g, "\n").trim();
      if (!text) {
        return null;
      }
      var style = xfdfTextStyle(element);
      data.annotationType = EDITOR_TYPE.FREETEXT;
      data.color = style.color;
      data.fontSize = style.fontSize;
      data.value = text;
      // pdf.js shifts an editor up by its font size the first time it draws
      // it (so a click lands on the text baseline); start the box that much
      // lower so it ends up exactly where the XFDF says. Done here, in PDF
      // space, so it holds whenever the page is drawn, even if pdf.js has
      // dropped that page's layer from its cache before then.
      data.rect = [rect[0], rect[1] - style.fontSize, rect[2], rect[3] - style.fontSize];
      // A new text box starts empty for typing (and an empty one isn't
      // saved); one marked as a copy shows the text it was given.
      data.isCopy = true;
      return { data: data, note: "" };
    }
    return null;
  }

  // Resolve with the annotation editor layer for a page, showing the page
  // first if pdf.js hasn't built that layer yet (it only does for pages
  // that have been rendered).
  function editorLayerFor(app, pageIndex) {
    var existing = editorUiManager.getLayer(pageIndex);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        app.eventBus.off("annotationeditorlayerrendered", onRendered);
        reject(new Error("page " + (pageIndex + 1) + " did not finish rendering"));
      }, 15000);
      function onRendered() {
        var layer = editorUiManager.getLayer(pageIndex);
        if (layer) {
          clearTimeout(timer);
          app.eventBus.off("annotationeditorlayerrendered", onRendered);
          resolve(layer);
        }
      }
      app.eventBus.on("annotationeditorlayerrendered", onRendered);
      app.page = pageIndex + 1;
    });
  }

  // Add the annotations in an XFDF document to the open PDF as unsaved
  // edits, exactly as if they had been drawn with the viewer's tools: undo
  // removes them (pdf.js also records each one as it's added, so redo brings
  // them back one at a time), and Ctrl/Cmd+S saves them into the PDF.
  function importXfdf(payload) {
    return firstOpen
      .then(function () {
        return documentReadyPromise;
      })
      .then(function (app) {
        if (!editorUiManager) {
          throw new Error("annotation editing isn't available for this PDF");
        }
        var xml = new DOMParser().parseFromString(String(payload.xml || ""), "application/xml");
        var root = xml.documentElement;
        if (!root || root.getElementsByTagName("parsererror").length || root.localName.toLowerCase() === "parsererror") {
          throw new Error("the file isn't valid XML");
        }
        if (root.localName.toLowerCase() !== "xfdf") {
          throw new Error("the file isn't XFDF (its root element is <" + root.localName + ">)");
        }

        // Was this XFDF made for this PDF? Compare its document ID with ours.
        var idsElement = childElements(root, "ids")[0];
        var theirId = idsElement ? String(idsElement.getAttribute("original") || "").toLowerCase() : "";
        var ourIds = (app.pdfDocument.fingerprints || []).map(function (id) {
          return String(id || "").toLowerCase();
        });
        if (theirId && ourIds.indexOf(theirId) === -1 && !payload.ignoreDocumentId) {
          var fileElement = childElements(root, "f")[0];
          return { differentDocument: true, href: fileElement ? fileElement.getAttribute("href") : null };
        }

        var numPages = app.pdfDocument.numPages;
        var byPage = new Map();
        var skipped = {};
        var outsideDocument = 0;
        var annots = childElements(root, "annots")[0];
        var elements = annots ? Array.prototype.slice.call(annots.children) : [];
        elements.forEach(function (element) {
          var type = element.localName.toLowerCase();
          if (type === "popup") {
            return;
          }
          var pageIndex = parseInt(element.getAttribute("page"), 10);
          if (!(pageIndex >= 0 && pageIndex < numPages)) {
            outsideDocument++;
            return;
          }
          var item = xfdfToEditorData(element, pageIndex);
          if (!item) {
            skipped[type] = (skipped[type] || 0) + 1;
            return;
          }
          if (!byPage.has(pageIndex)) {
            byPage.set(pageIndex, []);
          }
          byPage.get(pageIndex).push(item);
        });

        // Building editors needs each page's editor layer, which may mean
        // showing the page; return the reader to exactly where they were.
        var container = app.pdfViewer.container;
        var returnTop = container.scrollTop;
        var returnLeft = container.scrollLeft;
        var created = [];
        var chain = Promise.resolve();
        byPage.forEach(function (items, pageIndex) {
          chain = chain.then(function () {
            return editorLayerFor(app, pageIndex).then(function (layer) {
              return items.reduce(function (previous, item) {
                return previous.then(function () {
                  return layer.deserialize(item.data).then(function (editor) {
                    if (editor) {
                      // No offset the way pdf.js moves a pasted copy.
                      editor.isClone = true;
                      created.push({ editor: editor, note: item.note });
                    } else {
                      var name = String(item.data.annotationType);
                      skipped[name] = (skipped[name] || 0) + 1;
                    }
                  });
                });
              }, Promise.resolve());
            });
          });
        });
        return chain.then(function () {
          var addAll = function () {
            created.forEach(function (entry) {
              var layer = editorUiManager.getLayer(entry.editor.pageIndex);
              if (layer) {
                layer.addOrRebuild(entry.editor);
              } else {
                editorUiManager.addEditor(entry.editor);
                editorUiManager.addToAnnotationStorage(entry.editor);
              }
              // A note goes on once the annotation is on its page, inside
              // this same undo step (setting it can record its own).
              if (entry.note && !entry.noteSet) {
                entry.noteSet = true;
                entry.editor.comment = entry.note;
              }
            });
          };
          var removeAll = function () {
            created.forEach(function (entry) {
              entry.editor.remove();
            });
          };
          if (created.length) {
            markHostEdit();
            editorUiManager.addCommands({ cmd: addAll, undo: removeAll, mustExec: true });
          }
          container.scrollTop = returnTop;
          container.scrollLeft = returnLeft;
          return { imported: created.length, skipped: skipped, outsideDocument: outsideDocument };
        });
      });
  }

  // Requests from the extension host that need an answer.
  function answerRequest(message) {
    if (testMode && message.action === "neverAnswer") {
      return;
    }
    var work;
    if (message.action === "exportAnnotations") {
      work = exportAnnotations();
    } else if (message.action === "importXfdf") {
      work = importXfdf(message.payload || {});
    } else if (message.action === "flushEdits") {
      work = Promise.resolve(checkForEdits());
    } else {
      work = Promise.reject(new Error("unknown request: " + message.action));
    }
    work
      .then(function (result) {
        testLog("reply " + message.action);
        vscodeApi.postMessage({ type: "pdfphoenix-reply", requestId: message.requestId, result: result });
      })
      .catch(function (err) {
        testLog("request " + message.action + " failed: " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
        vscodeApi.postMessage({
          type: "pdfphoenix-reply",
          requestId: message.requestId,
          error: err && err.message ? err.message : String(err),
        });
      });
  }

  function replyWithBytes(requestId) {
    Promise.resolve(documentReadyPromise)
      .then(function (app) {
        if (!app || !app.pdfDocument) {
          throw new Error("the PDF viewer has not finished loading yet");
        }
        return app.pdfDocument.saveDocument();
      })
      .then(function (bytes) {
        // Sent as binary: VS Code transfers typed arrays without serializing.
        vscodeApi.postMessage({
          type: "pdfphoenix-bytes",
          requestId: requestId,
          data: bytes,
        });
      })
      .catch(function (err) {
        vscodeApi.postMessage({
          type: "pdfphoenix-bytes-error",
          requestId: requestId,
          message: err && err.message ? err.message : String(err),
        });
      });
  }

  // Integration-test hooks. The extension host only sets this attribute when
  // VS Code runs the extension's own test suite (ExtensionMode.Test); in
  // normal use these never answer anything.
  var testEditCount = 0;
  // pdf.js's annotation editor manager, announced once per viewer. Used to
  // import annotations (and by the test hooks).
  var editorUiManager = null;

  function testSnapshot() {
    var app = window.PDFViewerApplication;
    var options = window.PDFViewerApplicationOptions;
    var viewer = app && app.pdfViewer;
    var sidebar = app && (app.viewsManager || app.pdfSidebar);
    var loaded = !!(app && app.pdfDocument && app.isInitialViewSet && viewer && viewer.pagesCount > 0);
    var fields = {};
    var inputs = document.querySelectorAll(".annotationLayer input, .annotationLayer textarea");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].name) {
        fields[inputs[i].name] = inputs[i].value;
      }
    }
    return {
      renderStamp: settingsEl ? Number(settingsEl.getAttribute("data-pdfphoenix-render")) : null,
      loaded: loaded,
      page: loaded ? app.page : null,
      pagesCount: loaded ? viewer.pagesCount : 0,
      scale: loaded ? viewer.currentScale : null,
      scaleValue: loaded ? viewer.currentScaleValue : null,
      rotation: loaded ? viewer.pagesRotation : null,
      scrollMode: loaded ? viewer.scrollMode : null,
      spreadMode: loaded ? viewer.spreadMode : null,
      sidebarOpen: sidebar ? sidebar.isOpen : null,
      sidebarView: sidebar ? sidebar.visibleView : null,
      cursorTool: app && app.pdfCursorTools ? app.pdfCursorTools.activeTool : null,
      colorScheme: document.documentElement.style.getPropertyValue("color-scheme"),
      bodyClass: document.body ? document.body.className : "",
      forcePageColors: options ? options.get("forcePageColors") : null,
      pageColorsBackground: options ? options.get("pageColorsBackground") : null,
      pageColorsForeground: options ? options.get("pageColorsForeground") : null,
      enableScripting: options ? options.get("enableScripting") : null,
      scriptingReady: !!(app && app.pdfScriptingManager && app.pdfScriptingManager.ready),
      fields: fields,
      lang: document.documentElement.lang,
      navigatorLanguage: navigator.language,
      toolbarPageLabel: (document.getElementById("pageNumber") || {}).title || "",
      annotationStorageSize: app && app.pdfDocument ? app.pdfDocument.annotationStorage.size : 0,
      log: testLogEntries.slice(-20),
      pdfjsLoaded: typeof window.PDFViewerApplication === "object",
      // pdf.js sets this when it couldn't start its Web Worker and parses
      // PDFs on the page's own thread instead.
      fakeWorker: (function () {
        // Whether the open document talks to pdf.js's parser through a real
        // Web Worker or a same-thread stand-in: its loading task's PDFWorker
        // exposes the port it uses. null when that can't be determined.
        try {
          var task = app.pdfDocument.loadingTask;
          var port = task && task._worker && task._worker.port;
          return port ? !(typeof Worker !== "undefined" && port instanceof Worker) : null;
        } catch (err) {
          return null;
        }
      })(),
      workerSrc: window.PDFViewerApplicationOptions ? String(window.PDFViewerApplicationOptions.get("workerSrc")) : null,
      viewState: (vscodeApi.getState() || {}).view || null,
    };
  }

  function runTestAction(action, args) {
    var app = window.PDFViewerApplication;
    args = args || {};
    switch (action) {
      case "snapshot":
        return testSnapshot();
      case "setView": {
        var viewer = app.pdfViewer;
        if (args.scaleValue !== undefined) {
          viewer.currentScaleValue = String(args.scaleValue);
        }
        if (args.rotation !== undefined) {
          viewer.pagesRotation = args.rotation;
        }
        if (args.page !== undefined) {
          app.page = args.page;
        }
        var sidebar = app.viewsManager || app.pdfSidebar;
        if (args.sidebarOpen === false && sidebar && sidebar.isOpen) {
          sidebar.close();
        } else if (args.sidebarOpen === true && sidebar && !sidebar.isOpen) {
          sidebar.open();
        }
        return null;
      }
      case "markDirty":
        markHostEdit();
        // Any change to the annotation storage's content counts as an edit.
        app.pdfDocument.annotationStorage.setValue("pdfphoenix-test-" + ++testEditCount, {
          value: testEditCount,
        });
        return null;
      case "setEditorMode":
        // pdf.js AnnotationEditorType: NONE 0, FREETEXT 3, HIGHLIGHT 9, INK 15.
        app.pdfViewer.annotationEditorMode = { mode: args.mode };
        testLog("mode " + args.mode);
        return null;
      case "drawInk": {
        // Draw a short stroke with pointer events on the current page's
        // editor layer, as a user would with the draw tool, then report the
        // properties of the annotation that produced (like createEditor).
        var layer = document.querySelector(
          '.page[data-page-number="' + app.page + '"] .annotationEditorLayer'
        );
        if (!layer) {
          throw new Error("no annotation editor layer on the current page");
        }
        var box = layer.getBoundingClientRect();
        var point = function (type, fx, fy, target) {
          (target || layer).dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              clientX: box.left + box.width * fx,
              clientY: box.top + box.height * fy,
            })
          );
        };
        // pdf.js listens for the stroke's moves on the layer itself and for
        // its end on window, and turns a drawing session into an annotation
        // when the session ends, here by leaving the draw tool.
        point("pointerdown", 0.3, 0.3);
        for (var k = 1; k <= 10; k++) {
          point("pointermove", 0.3 + k * 0.02, 0.3 + k * 0.01);
        }
        point("pointerup", 0.5, 0.4, window);
        app.pdfViewer.annotationEditorMode = { mode: 0 };
        return new Promise(function (resolve) {
          setTimeout(function () {
            var last = null;
            if (editorUiManager) {
              var all = editorUiManager.getEditors(app.page - 1);
              for (var st = all.next(); !st.done; st = all.next()) {
                last = st.value;
              }
            }
            resolve(last ? last.propertiesToUpdate : null);
          }, 300);
        });
      }
      case "createEditor": {
        // AnnotationEditorParamsType.CREATE: add a new annotation of the
        // current tool at the page's center, then report the properties it
        // was actually created with, as [AnnotationEditorParamsType, value].
        app.eventBus.dispatch("switchannotationeditorparams", { source: window, type: 2, value: {} });
        var newest = null;
        if (editorUiManager) {
          var editors = editorUiManager.getEditors(app.page - 1);
          for (var step = editors.next(); !step.done; step = editors.next()) {
            newest = step.value;
          }
        }
        return newest ? newest.propertiesToUpdate : null;
      }
      case "editorToolbar": {
        var value = function (id) {
          var el = document.getElementById(id);
          return el ? el.value : null;
        };
        var selected = document.querySelector('#editorHighlightColorPicker [aria-selected="true"]');
        return {
          inkColor: value("editorInkColor"),
          inkThickness: value("editorInkThickness"),
          textColor: value("editorFreeTextColor"),
          textSize: value("editorFreeTextFontSize"),
          highlightColor: selected ? selected.getAttribute("data-color") : null,
        };
      }
      case "setField":
        markHostEdit();
        app.pdfDocument.annotationStorage.setValue(args.id, { value: args.value });
        return null;
      case "pauseEditWatch":
        // Stop the 200ms edit check, so an edit stays unreported until the
        // extension host asks (flushEdits).
        clearInterval(editWatchInterval);
        return null;
      case "undo":
        editorUiManager.undo();
        return null;
      default:
        throw new Error("unknown test action: " + action);
    }
  }

  function answerTest(message) {
    Promise.resolve()
      .then(function () {
        return runTestAction(message.action, message.args);
      })
      .then(function (result) {
        vscodeApi.postMessage({ type: "pdfphoenix-test-result", requestId: message.requestId, result: result });
      })
      .catch(function (err) {
        vscodeApi.postMessage({
          type: "pdfphoenix-test-result",
          requestId: message.requestId,
          error: err && err.message ? err.message : String(err),
        });
      });
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message) {
      return;
    }
    if (message.type === "pdfphoenix-load") {
      tryOpen(message.data, message.filename);
    } else if (message.type === "pdfphoenix-get-bytes") {
      replyWithBytes(message.requestId);
    } else if (message.type === "pdfphoenix-request") {
      answerRequest(message);
    } else if (message.type === "pdfphoenix-test" && testMode) {
      answerTest(message);
    } else if (message.type === "pdfphoenix-theme-settings") {
      viewerThemeSetting = message.viewerTheme;
      pageColorsSetting = message.pageColors;
      onThemeChanged();
    }
  });

  document.addEventListener("webviewerloaded", function () {
    viewerStarted = true;
    var options = window.PDFViewerApplicationOptions;
    if (options) {
      // Apply the user's chosen defaults every time rather than letting
      // pdf.js's own localStorage-backed "Preferences" remember whatever was
      // last used. Values come from the extension's pdfPhoenix.defaultZoom and
      // pdfPhoenix.defaultSidebar settings; fall back if anything unexpected
      // slips through.
      var zoom = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-zoom") : null;
      var sidebar = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-sidebar") : null;

      options.set("disablePreferences", true);
      // pdf.js otherwise reopens a document where it was last left, from its
      // own history in the webview's localStorage. That history is keyed by
      // the PDF's content fingerprint (so identical copies share a place) and
      // lives in storage the extension doesn't control. Always start from the
      // initial view; restoring a place is handled by the extension itself.
      options.set("viewOnLoad", 1 /* ViewOnLoad.INITIAL */);
      options.set("defaultZoomValue", ALLOWED_ZOOM[zoom] ? zoom : "page-fit");
      options.set(
        "sidebarViewOnLoad",
        sidebar in SIDEBAR_VIEW ? SIDEBAR_VIEW[sidebar] : SIDEBAR_VIEW.outline
      );
      // Point pdf.js at its own side-assets via the webview URIs the extension
      // host computed. pdf.js's built-in defaults for these are relative
      // ("../web/cmaps/", "../web/wasm/", etc.) and resolve against the webview
      // shell's document origin, not the resource host where the files actually
      // live - so they 404 the moment a PDF needs them: cMaps for CJK text,
      // standard font data for non-embedded base-14 fonts, the wasm decoders
      // for JPEG2000/JBIG2 images and ICC-based colour, and the sandbox for
      // embedded JavaScript. Only pdf.mjs/viewer.mjs/viewer.css/locale get
      // rewritten in the HTML; everything else has to be threaded through here.
      // Missing an attribute leaves pdf.js's own default untouched.
      setModeOption(options, "scrollModeOnLoad", SCROLL_MODE, "data-pdfphoenix-scroll-mode");
      setModeOption(options, "spreadModeOnLoad", SPREAD_MODE, "data-pdfphoenix-spread-mode");
      setModeOption(options, "cursorToolOnLoad", CURSOR_TOOL, "data-pdfphoenix-cursor-tool");
      // A view being restored after a reload wins over the opening defaults.
      applyRestoredModes(options);
      // Show pdf.js's toolbar, menus and messages in VS Code's display
      // language (pdf.js falls back to English for languages it lacks).
      var locale = settingsEl ? settingsEl.getAttribute("data-pdfphoenix-locale") : null;
      if (locale) {
        options.set("localeProperties", { lang: locale });
      }
      // The extension host sets this to "off" in Restricted Mode, so
      // JavaScript embedded in the PDF doesn't run until the workspace is
      // trusted (it then rebuilds this viewer with it back on).
      if (settingsEl && settingsEl.getAttribute("data-pdfphoenix-scripting") === "off") {
        options.set("enableScripting", false);
      }
      setAssetOption(options, "cMapUrl", "data-pdfphoenix-cmap-url");
      setAssetOption(options, "standardFontDataUrl", "data-pdfphoenix-standard-fonts-url");
      setAssetOption(options, "wasmUrl", "data-pdfphoenix-wasm-url");
      setAssetOption(options, "iccUrl", "data-pdfphoenix-icc-url");
      setAssetOption(options, "sandboxBundleSrc", "data-pdfphoenix-sandbox-src");
      // pdf.js's own Ctrl+S/download button write to a browser-downloaded
      // file, which in a VS Code webview surfaces as a native OS save
      // dialog. Saving is handled entirely by VS Code's own Ctrl+S (which
      // calls PdfViewerProvider.saveCustomDocument, not anything in this
      // page), so disable pdf.js's competing save path. This also makes
      // downloadOrSave()/save()/download() no-ops (they all bail out early
      // when downloadManager is null), which is what actually stops the
      // dialog rather than just hiding the button.
      options.set("supportsDownloading", false);
    }
    startThemeTracking(options);
    vscodeApi.postMessage({ type: "pdfphoenix-ready" });
  });
})();
