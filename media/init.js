(function () {
  var vscodeApi = acquireVsCodeApi();

  // The extension host passes the user's default-zoom / default-sidebar
  // settings as data-* attributes on this script tag. Captured here because
  // document.currentScript is only valid while this script first runs, not
  // later inside the event handler that reads them. Attributes (unlike an
  // inline <script>) aren't blocked by viewer.html's Content-Security-Policy.
  var settingsEl = document.currentScript;

  var SIDEBAR_VIEW = { none: 0, thumbnails: 1, outline: 2 };
  var ALLOWED_ZOOM = { auto: 1, "page-fit": 1, "page-width": 1, "page-actual": 1 };

  function base64ToBytes(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
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
  function watchForEdits() {
    var app = window.PDFViewerApplication;
    var lastHash = app.pdfDocument.annotationStorage.serializable.hash;
    setInterval(function () {
      var storage = app.pdfDocument && app.pdfDocument.annotationStorage;
      if (!storage) {
        return;
      }
      var currentHash = storage.serializable.hash;
      if (currentHash !== lastHash) {
        lastHash = currentHash;
        vscodeApi.postMessage({ type: "pdfphoenix-dirty" });
      }
    }, 200);
  }

  function tryOpen(bytes, filename) {
    var app = window.PDFViewerApplication;
    if (app && app.initializedPromise) {
      app.initializedPromise.then(function () {
        return app.open({ data: bytes, filename: filename });
      }).then(watchForEdits);
    } else {
      setTimeout(function () {
        tryOpen(bytes, filename);
      }, 30);
    }
  }

  function replyWithBytes(requestId) {
    var app = window.PDFViewerApplication;
    Promise.resolve(app.pdfDocument.saveDocument()).then(function (bytes) {
      vscodeApi.postMessage({
        type: "pdfphoenix-bytes",
        requestId: requestId,
        data: bytesToBase64(bytes),
      });
    });
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message) {
      return;
    }
    if (message.type === "pdfphoenix-load") {
      tryOpen(base64ToBytes(message.data), message.filename);
    } else if (message.type === "pdfphoenix-get-bytes") {
      replyWithBytes(message.requestId);
    }
  });

  document.addEventListener("webviewerloaded", function () {
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
      options.set("defaultZoomValue", ALLOWED_ZOOM[zoom] ? zoom : "page-fit");
      options.set(
        "sidebarViewOnLoad",
        sidebar in SIDEBAR_VIEW ? SIDEBAR_VIEW[sidebar] : SIDEBAR_VIEW.outline
      );
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
    vscodeApi.postMessage({ type: "pdfphoenix-ready" });
  });
})();
